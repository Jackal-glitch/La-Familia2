(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Lending = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  /* ============================================================================
     Règle de La Familia : un prêt n'a pas de durée. Chaque mois, le client verse
     20 % (le taux) du capital prêté. Pour mettre fin au prêt, il rend le capital
     et paie 20 % pour le mois en cours (aucun prorata).

     Les mois se comptent à partir de la date du prêt (date anniversaire). Le mois n
     couvre la période (date + n-1 mois ; date + n mois]. Son intérêt est dû à la fin
     du mois, et est en retard à partir du lendemain.
     Un paiement rembourse d'abord les intérêts (du plus ancien au mois en cours),
     puis le capital. Le capital restant sert de base aux mois suivants.
     Ce fichier est utilisé tel quel par l'application et par le serveur.
     ============================================================================ */
  const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const EPS = 0.004;
  const pad = n => String(n).padStart(2, '0');
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };
  const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  // Ajoute n mois à une date AAAA-MM-JJ (le 31 janvier + 1 mois = le 28 ou 29 février)
  function addMonths(s, n) {
    const { y, m, d } = parse(s), t = (m - 1) + n;
    const ty = y + Math.floor(t / 12), tm = ((t % 12) + 12) % 12 + 1;
    return fmt(ty, tm, Math.min(d, new Date(ty, tm, 0).getDate()));
  }
  const diffDays = (a, b) => { const A = parse(a), B = parse(b); return Math.round((new Date(B.y, B.m - 1, B.d) - new Date(A.y, A.m - 1, A.d)) / 864e5); };

  // Numéro du mois (à partir de 1) auquel appartient la date t : le plus petit k tel que fin du mois k >= t
  function cycleIndex(d0, t) {
    const a = parse(d0), b = parse(t);
    let k = Math.max(1, (b.y - a.y) * 12 + (b.m - a.m) - 1);
    while (addMonths(d0, k) < t) k++;
    while (k > 1 && addMonths(d0, k - 1) >= t) k--;
    return k;
  }

  /* loan : { principal, rate (% par mois), startDate, writtenOff: {date} | null }
     payments : [{ id?, date, amount }]   today : AAAA-MM-JJ */
  function compute(loan, payments, today) {
    const P = round2(loan.principal), rate = Number(loan.rate) || 0, d0 = loan.startDate;
    const pays = (payments || []).map((p, i) => ({ ...p, _i: i })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a._i - b._i));
    const cycles = [], repaid = []; // repaid : remboursements de capital {date, amount}
    const principalAt = d => round2(P - repaid.reduce((s, r) => (r.date <= d ? s + r.amount : s), 0));
    const principalNow = () => round2(P - repaid.reduce((s, r) => s + r.amount, 0));
    const ensure = K => {
      for (let k = cycles.length + 1; k <= K; k++) {
        const start = k === 1 ? d0 : addMonths(d0, k - 1), base = principalAt(start);
        if (base <= EPS) break; // capital déjà rendu : plus d'intérêts
        cycles.push({ k, start, end: addMonths(d0, k), base, interest: round2(base * rate / 100), paid: 0 });
      }
    };

    const allocations = []; let closedDate = null, excess = 0;
    for (const p of pays) {
      const amount = round2(p.amount);
      if (principalNow() <= EPS) { allocations.push({ id: p.id, date: p.date, amount, interest: 0, principal: 0, excess: amount }); excess = round2(excess + amount); continue; }
      ensure(cycleIndex(d0, p.date));
      let left = amount, ip = 0;
      for (const c of cycles) { // intérêts d'abord, du plus ancien au mois en cours
        if (left <= EPS) break;
        const use = Math.min(round2(c.interest - c.paid), left);
        if (use > EPS) { c.paid = round2(c.paid + use); left = round2(left - use); ip = round2(ip + use); }
      }
      const use = Math.min(principalNow(), left), pp = use > EPS ? round2(use) : 0;
      if (pp > 0) { repaid.push({ date: p.date, amount: pp }); left = round2(left - pp); if (principalNow() <= EPS) closedDate = p.date; }
      const ex = left > EPS ? left : 0; excess = round2(excess + ex);
      allocations.push({ id: p.id, date: p.date, amount, interest: ip, principal: pp, excess: ex });
    }

    const principalOut = principalNow(), closed = principalOut <= EPS, lost = !!loan.writtenOff;
    if (!closed) ensure(cycleIndex(d0, today > d0 ? today : d0));

    let overdue = 0, dueNow = 0, accruing = 0, oldestOverdue = null;
    const view = cycles.map(c => {
      const unpaid = round2(c.interest - c.paid);
      const state = unpaid <= EPS ? 'paid' : c.end < today ? 'overdue' : c.end === today ? 'due' : 'current';
      if (!closed && !lost) {
        if (state === 'overdue') { overdue = round2(overdue + unpaid); if (!oldestOverdue) oldestOverdue = c.end; }
        if (state === 'overdue' || state === 'due') dueNow = round2(dueNow + unpaid);
        if (state === 'current') accruing = round2(accruing + unpaid);
      }
      return { ...c, unpaid, state };
    });
    const unpaidAll = view.reduce((s, c) => round2(s + c.unpaid), 0);
    const payoff = closed ? 0 : round2(principalOut + unpaidAll);
    const monthlyInterest = closed ? 0 : round2(principalOut * rate / 100);
    let nextDue = null;
    if (!closed && !lost) {
      const firstUnpaid = view.find(c => c.unpaid > EPS);
      nextDue = firstUnpaid ? { date: firstUnpaid.end, amount: firstUnpaid.unpaid } : { date: addMonths(d0, (view.length ? view[view.length - 1].k : 0) + 1), amount: monthlyInterest };
    }
    const interestPaid = allocations.reduce((s, a) => round2(s + a.interest), 0), principalPaid = allocations.reduce((s, a) => round2(s + a.principal), 0);
    return {
      status: lost ? 'perdu' : closed ? 'rembourse' : overdue > EPS ? 'retard' : 'encours',
      principalOut, principalPaid, interestPaid, totalPaid: round2(interestPaid + principalPaid),
      cycles: view, months: view.length ? view[view.length - 1].k : 0, monthlyInterest,
      overdue, dueNow, accruing, payoff, nextDue, closedDate,
      overdueSince: oldestOverdue, daysLate: oldestOverdue ? diffDays(oldestOverdue, today) : 0,
      lost: lost ? principalOut : 0, allocations, excess
    };
  }

  // Somme à payer pour tout solder à la date indiquée, sachant les paiements déjà faits (à cette date ou avant)
  function payoffAt(loan, payments, date) {
    return compute({ ...loan, writtenOff: null }, (payments || []).filter(p => p.date <= date), date).payoff;
  }

  return { round2, addMonths, diffDays, cycleIndex, compute, payoffAt };
});

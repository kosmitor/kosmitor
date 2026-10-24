# The math

How `packages/core` computes the figures that are easy to get wrong.

**Vesting** uses cumulative-floor allocation — shares vested through period *i*
are `floor(total × i / n)`. A grant never vests ahead of schedule from rounding,
and tranches always sum exactly to the grant.

**Priced rounds** are a fixed point. The share price depends on the option pool
top-up and the converting SAFEs; the pool depends on the post-round total, which
depends on the price. The solver iterates:

```
PPS  = preMoney / (existingFD + poolIncrease + convertedShares)
N    = investment / PPS
T    = (existingFD + converted + N − existingPool) / (1 − targetPool%)
pool = targetPool% × T − existingPool
```

This reproduces the standard pool-shuffle result: on a $8M pre / $2M raise with a
10% post-close pool, investors get 20%, the pool is 10%, founders hold 70%.

**Post-money SAFEs** take a fixed ownership slice (`principal / cap`) of the
company before new money, so the set is solved together rather than sequentially.

**Waterfalls** are a best-response search over conversion elections. Every
claimant — each preferred class, and each SAFE or unrepaid note choosing between
its cash-out and converting at its cap — is given whichever election pays it
more given everyone else's, re-evaluated until nobody wants to change. Inside
each evaluation, which options are in the money is a fixed point (they help set
the price that decides it), and a capped participating class is fixed at its
cap and removed from the per-share split so the excess flows to the others
rather than vanishing. Common absorbs the per-share rounding, so payouts
reconcile to the distributable amount to the cent at every exit value.

**Stock splits** are normalised away before any formula runs: share counts are
multiplied and per-share prices divided, so a $2M preference stays $2M and a
$1.00 strike on 100 options becomes $0.50 on 200. A custom schedule whose tranches
are share counts is restated with the security it vests (a copy, `<id>@<factor>`), so
a split grant still vests all of itself and never more than it holds.

## Compliance checks

ISO $100,000 first-exercisable limit with NSO recharacterisation (an
early-exercisable grant counts in full in its grant year), Rule 701's three
ceilings (the 15%-of-outstanding prong is compared in shares, not dollars),
83(b) 30-day deadlines, 409A expiry and below-FMV strikes, missing or backdated
board approval, post-termination exercise windows, note maturity, authorized
share and plan-reserve capacity.

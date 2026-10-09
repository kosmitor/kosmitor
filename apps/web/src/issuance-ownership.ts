const safeQuantity = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/** This issuance's percentage of fully diluted shares after it becomes outstanding. */
export function ownershipForShares(quantity: number, fullyDiluted: number, conversionRatio = 1): number | null {
  if (!safeQuantity(quantity) || quantity <= 0 || !safeQuantity(fullyDiluted)
    || !Number.isFinite(conversionRatio) || conversionRatio <= 0) return null;
  const converted = quantity * conversionRatio;
  const total = fullyDiluted + converted;
  if (!safeQuantity(converted) || converted <= 0 || !safeQuantity(total)) return null;
  return converted / total * 100;
}

/** Whole shares nearest to a target percentage, including this issuance in the denominator. */
export function sharesForOwnership(targetPercent: number, fullyDiluted: number, conversionRatio = 1): number | null {
  if (!Number.isFinite(targetPercent) || targetPercent <= 0 || targetPercent >= 100
    || !safeQuantity(fullyDiluted) || fullyDiluted <= 0
    || !Number.isFinite(conversionRatio) || conversionRatio <= 0) return null;
  const quantity = Math.round(fullyDiluted * (targetPercent / (100 - targetPercent)) / conversionRatio);
  if (!Number.isSafeInteger(quantity) || quantity < 1
    || ownershipForShares(quantity, fullyDiluted, conversionRatio) === null) return null;
  return quantity;
}

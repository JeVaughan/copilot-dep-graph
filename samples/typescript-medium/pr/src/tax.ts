export function computeTax(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100;
}

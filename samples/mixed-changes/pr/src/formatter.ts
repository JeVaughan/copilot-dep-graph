export function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

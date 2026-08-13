import { formatCurrency } from "./formatter";

export function legacyFormat(n: number): string {
  return formatCurrency(n);
}

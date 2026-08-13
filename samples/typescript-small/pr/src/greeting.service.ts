import { add, subtract } from "./math-utils";
import { formatCurrency } from "./formatter";

export class GreetingService {
  count = computed(() => this.computeTotal(1, 2));

  computeTotal(a: number, b: number): number {
    return add(a, b);
  }

  formattedTotal(a: number, b: number): string {
    return formatCurrency(this.computeTotal(a, b));
  }

  difference(a: number, b: number): number {
    return subtract(a, b);
  }
}

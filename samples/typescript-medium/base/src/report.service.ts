import { add, multiply, roundTo } from "./math-utils";
import { formatCurrency } from "./formatter";

export class ReportService {
  computeTotal(a: number, b: number): number {
    return roundTo(add(a, b), -2);
  }

  computeArea(w: number, h: number): number {
    return multiply(w, h);
  }

  display(a: number, b: number): string {
    return formatCurrency(this.computeTotal(a, b));
  }

  unrelatedHelper(): number {
    return 42;
  }
}

export function add(a: number, b: number): number {
  return a + b;
}


export function sum(a: number[]): number {
  let total: number = 0;
  for (const elem of a) {
    total = add(total, elem);
  }
  return total;
}


export function multiply(a: number, b: number): number {
  return a * b;
}


export function product(a: number[]): number {
  let total: number = 1;
  for (const elem of a) {
    total = multiply(total, elem);
  }
  return total;
}


export function divide(a: number, b: number): number {
  return a / b;
}


export function mod(a: number, b: number): number {
  return a % b;
}


export function pow(a: number, b: number): number {
  return a ** b;
}

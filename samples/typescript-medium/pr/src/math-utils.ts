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


// New function, so its call to divide() is an ADDED edge — divide() itself is
// untouched text, so it lands on the "unchanged node, changed edge" tier via a
// different edge status (added) than add() does below (modified).
export function subtract(a: number, b: number): number {
  return divide(a - b, 1);
}


export function mod(a: number, b: number): number {
  return a % b;
}


export function pow(a: number, b: number): number {
  return Math.pow(a, b);
}


export function roundTo(a: number, digits: number): number {
  const factor = pow(10, digits);
  return Math.round(a * factor) / factor;
}
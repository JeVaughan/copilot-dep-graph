export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
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

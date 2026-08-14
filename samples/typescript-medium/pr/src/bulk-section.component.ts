import { ConfirmedBulkPurge } from "./bulk-selection";

// ConfirmedBulkPurge is used only in a type position here — never called, never
// `new`'d — so it can't produce a call edge (tree-sitter only traces call/new
// expressions). It falls through to the named-import reference-edge path instead.
export class BulkSectionComponent {
  pendingConfirmation?: ConfirmedBulkPurge;
}

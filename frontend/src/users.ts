/** Demo customers. There is no login: switching user just changes which customer id the browser declares. */
export interface Customer {
  id: string;
  name: string;
  initials: string;
  /** Avatar gradient, taken from the brand palette. */
  gradient: string;
}

export const CUSTOMERS: Customer[] = [
  { id: "u-aisha", name: "Aisha Khan", initials: "AK", gradient: "linear-gradient(135deg, #5a5fe5, #7a7fee)" },
  { id: "u-ben", name: "Ben Carter", initials: "BC", gradient: "linear-gradient(135deg, #4f92db, #6fb0ee)" },
  { id: "u-chloe", name: "Chloe Martin", initials: "CM", gradient: "linear-gradient(135deg, #49c2d2, #6fdce8)" },
];

export const customerById = (id: string | null) => CUSTOMERS.find((c) => c.id === id) ?? null;
export const customerName = (id: string | null) => customerById(id)?.name ?? "Guest";

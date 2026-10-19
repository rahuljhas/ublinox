import { useEffect, useRef, useState } from "react";
import { CUSTOMERS, type Customer } from "./users";

function Avatar({ customer, size = 32 }: { customer: Customer; size?: number }) {
  return (
    <span className="avatar" style={{ background: customer.gradient, width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {customer.initials}
    </span>
  );
}

/** Header control to pick which demo customer is shopping. Each customer has their own cart and order history. */
export function UserSwitcher({ current, onSelect }: { current: Customer; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="user-switcher" ref={root}>
      <button className="user-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Avatar customer={current} />
        <span className="user-text">
          <small>Shopping as</small>
          <strong>{current.name}</strong>
        </span>
        <span className="chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="user-menu" role="menu" aria-label="Switch customer">
          <p className="user-menu-title">Switch customer</p>
          {CUSTOMERS.map((customer) => {
            const active = customer.id === current.id;
            return (
              <button
                key={customer.id}
                role="menuitemradio"
                aria-checked={active}
                className={`user-item ${active ? "active" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (!active) onSelect(customer.id);
                }}
              >
                <Avatar customer={customer} size={34} />
                <span className="user-text">
                  <strong>{customer.name}</strong>
                  <small>{customer.id}</small>
                </span>
                {active && <span className="check">✓</span>}
              </button>
            );
          })}
          <p className="user-menu-note">Each customer has a separate cart and order history. There is no login in this demo.</p>
        </div>
      )}
    </div>
  );
}

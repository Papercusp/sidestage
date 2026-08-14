import { FormEvent, useEffect, useState } from 'react';

import { normalizeBuyerIdentity } from './buyer-identity';
import './buyer-identity.css';

export interface BuyerIdentityControlProps {
  buyerId: string;
  onImpersonate: (buyerId: string) => void;
}

/** D-013 demo-only identity switcher — deliberately no password or auth flow. */
export function BuyerIdentityControl({ buyerId, onImpersonate }: BuyerIdentityControlProps) {
  const [draft, setDraft] = useState(buyerId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(buyerId), [buyerId]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = normalizeBuyerIdentity(draft);
    if (!next) {
      setError('Enter a user id to switch demo users.');
      return;
    }
    setError(null);
    setDraft(next);
    onImpersonate(next);
  };

  return (
    <form className="buyer-identity" onSubmit={submit} aria-label="Demo user impersonation">
      <div className="buyer-identity-heading">
        <span>Demo user</span>
        <strong title={buyerId}>{buyerId}</strong>
      </div>
      <div className="buyer-identity-row">
        <label className="sr-only" htmlFor="buyer-demo-user-id">User id</label>
        <input
          id="buyer-demo-user-id"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Enter any user id"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="buyer-demo-user-help"
          aria-invalid={Boolean(error)}
        />
        <button className="button secondary" type="submit">Switch</button>
      </div>
      <small id="buyer-demo-user-help">Demo only — any non-empty id, no password.</small>
      {error ? <span className="buyer-identity-error" role="alert">{error}</span> : null}
    </form>
  );
}

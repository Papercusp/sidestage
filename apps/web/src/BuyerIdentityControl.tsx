import { FormEvent, useEffect, useState } from 'react';

import { normalizeDemoIdentity } from './buyer-identity';
import './buyer-identity.css';

export interface DemoIdentityControlProps {
  userId: string;
  onImpersonate: (userId: string) => void;
  inputId?: string;
  label?: string;
}

export interface BuyerIdentityControlProps {
  buyerId: string;
  onImpersonate: (buyerId: string) => void;
}

/** D-013 demo-only identity switcher — deliberately no password or auth flow. */
export function DemoIdentityControl({
  userId,
  onImpersonate,
  inputId = 'demo-user-id',
  label = 'Demo user',
}: DemoIdentityControlProps) {
  const [draft, setDraft] = useState(userId);
  const [error, setError] = useState<string | null>(null);
  const helpId = `${inputId}-help`;

  useEffect(() => setDraft(userId), [userId]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = normalizeDemoIdentity(draft);
    if (!next) {
      setError('Enter a user id to switch demo users.');
      return;
    }
    setError(null);
    setDraft(next);
    onImpersonate(next);
  };

  return (
    <form className="demo-identity" onSubmit={submit} aria-label={`${label} impersonation`}>
      <div className="demo-identity-heading">
        <span>{label}</span>
        <strong title={userId}>{userId}</strong>
      </div>
      <div className="demo-identity-row">
        <label className="sr-only" htmlFor={inputId}>User id</label>
        <input
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Enter any user id"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={helpId}
          aria-invalid={Boolean(error)}
        />
        <button className="button secondary" type="submit">Switch</button>
      </div>
      <small id={helpId}>Demo only — any non-empty id, no password.</small>
      {error ? <span className="demo-identity-error" role="alert">{error}</span> : null}
    </form>
  );
}

/** Compatibility wrapper for buyer-only imports while the app uses one user id. */
export function BuyerIdentityControl({ buyerId, onImpersonate }: BuyerIdentityControlProps) {
  return (
    <DemoIdentityControl
      userId={buyerId}
      onImpersonate={onImpersonate}
      inputId="buyer-demo-user-id"
    />
  );
}

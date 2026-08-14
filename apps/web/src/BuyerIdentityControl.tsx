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

function visibleDemoIdentity(userId: string): string {
  const persona = userId.replace(/^(?:buyer|seller)-+/i, '');
  return persona || userId;
}

/** D-013 demo-only identity switcher — deliberately no password or auth flow. */
export function DemoIdentityControl({
  userId,
  onImpersonate,
  inputId = 'demo-user-id',
  label = 'Demo user',
}: DemoIdentityControlProps) {
  const visibleUserId = visibleDemoIdentity(userId);
  const [draft, setDraft] = useState(visibleUserId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(visibleUserId), [visibleUserId]);

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
        <strong title={visibleUserId}>{visibleUserId}</strong>
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
          aria-invalid={Boolean(error)}
        />
        <button className="button secondary" type="submit">Switch</button>
      </div>
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

import type { CSSProperties } from 'react';

export type ProductTone = 'cyan' | 'violet' | 'amber';

export interface ProductCardProps {
  id: string;
  name: string;
  price: string;
  compareAt?: string;
  description: string;
  badge?: string;
  stockLabel?: string;
  tone?: ProductTone;
  glyph?: string;
  selected?: boolean;
  onSelect?: (id: string) => void;
}

/**
 * A small, data-only product presentation used by both the buyer catalog and
 * seller's on-stage queue. Keeping the card independent of fetching/state
 * makes it safe to reuse when the catalog service arrives in a later phase.
 */
export function ProductCard({
  id,
  name,
  price,
  compareAt,
  description,
  badge,
  stockLabel = 'In stock',
  tone = 'cyan',
  glyph = '✦',
  selected = false,
  onSelect,
}: ProductCardProps) {
  const mediaStyle = { '--product-accent': `var(--${tone})` } as CSSProperties;

  return (
    <article className={`product-card${selected ? ' is-selected' : ''}`} data-product-id={id}>
      <div className={`product-card-media tone-${tone}`} style={mediaStyle} aria-hidden="true">
        <span>{glyph}</span>
      </div>
      <div className="product-card-content">
        <div className="product-card-meta">
          {badge ? <span className="product-badge">{badge}</span> : <span />}
          <span className="product-stock">{stockLabel}</span>
        </div>
        <h3>{name}</h3>
        <p>{description}</p>
        <div className="product-card-footer">
          <div className="product-price" aria-label={`Price ${price}`}>
            <strong>{price}</strong>
            {compareAt ? <del>{compareAt}</del> : null}
          </div>
          {onSelect ? (
            <button className="card-action" type="button" onClick={() => onSelect(id)}>
              {selected ? 'On deck' : 'Add to stage'}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

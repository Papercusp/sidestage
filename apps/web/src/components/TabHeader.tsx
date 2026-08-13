export function TabHeader({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return (
    <div className="tab-header">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="tab-copy">{copy}</p>
    </div>
  );
}

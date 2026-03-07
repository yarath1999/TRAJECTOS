type CauseCardProps = {
  primary: string;
  secondary?: string;
};

export default function CauseCard({ primary, secondary }: CauseCardProps) {
  return (
    <div className="border border-foreground/15 rounded-lg p-4 mt-4">
      <div className="text-sm font-semibold">Trajectory Cause</div>

      <div className="mt-3">
        <div className="text-sm font-semibold">Primary Cause</div>
        <div className="mt-1 text-sm text-foreground/70">{primary}</div>
      </div>

      {secondary && (
        <div className="mt-3">
          <div className="text-sm font-semibold">Secondary Cause</div>
          <div className="mt-1 text-sm text-foreground/70">{secondary}</div>
        </div>
      )}
    </div>
  );
}

export default function ReturnInsight({ message }: { message: string }) {
  return (
    <div className="border border-foreground/15 rounded-lg p-4 mt-4">
      <div className="text-sm font-semibold">Return Assumption Insight</div>
      <div className="mt-1 text-sm text-foreground/70">{message}</div>
    </div>
  );
}

type InsightCardProps = {
  title: string;
  message: string;
};

export default function InsightCard({ title, message }: InsightCardProps) {
  return (
    <div className="border border-foreground/15 rounded-lg p-4 mt-6">
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-sm text-foreground/70">{message}</div>
    </div>
  );
}

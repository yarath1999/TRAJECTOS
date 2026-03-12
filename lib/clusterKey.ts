export function generateClusterKey(title: string): string {

  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .filter(word => word.length > 3)
    .slice(0,5)
    .sort()
    .join("_");

  return normalized;
}

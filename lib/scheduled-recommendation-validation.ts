export function isSchedulableRecommendation(row: {
  recommendedServiceId: string | null;
  scheduledAt: number | null;
}): boolean {
  return row.scheduledAt === null || row.recommendedServiceId !== null;
}

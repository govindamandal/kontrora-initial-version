import { z } from 'zod';
export const estimateStatuses = ['draft', 'sent', 'accepted', 'rejected'] as const;
export const currencies = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD'] as const;
export const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const lineItemSchema = z
  .object({
    description: z.string().trim().min(1).max(300),
    quantity: z.number().int().min(1).max(10000),
    unit_price_minor: z.number().int().min(0).max(1000000000),
  })
  .strict();
export const estimateContentSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    currency: z.enum(currencies),
    notes: z.string().max(4000).default(''),
    project_id: uuid.nullable().default(null),
    items: z.array(lineItemSchema).min(1).max(50),
  })
  .strict()
  .refine(
    (v) => v.items.reduce((sum, i) => sum + i.quantity * i.unit_price_minor, 0) <= 9000000000000,
    { message: 'Estimate total exceeds the limit' },
  );
export const estimateUpdateSchema = z.union([
  z.object({ version: z.number().int().positive(), content: estimateContentSchema }).strict(),
  z
    .object({
      version: z.number().int().positive(),
      status: z.enum(['sent', 'accepted', 'rejected']),
    })
    .strict(),
]);
// All supported currencies have two fractional digits. Never round float inputs.
export function parseMoneyMinor(value: string): number {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(value))
    throw new Error('Enter a price with up to two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (minor > 1000000000) throw new Error('Unit price must be at most 10,000,000.00');
  return minor;
}
export function formatMoney(minor: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}
export type EstimateContent = z.infer<typeof estimateContentSchema>;

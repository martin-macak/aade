export const total = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
export type Row = { readonly id: string };

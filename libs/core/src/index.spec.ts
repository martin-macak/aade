import { describeProduct } from './index.js';

it('combines the product name and the version', () => {
  expect(describeProduct('1.2.0')).toBe('aade 1.2.0');
});

export interface Category {
  id: string;
  name: string;
  parentId?: string;
}

export const CATEGORIES: Category[] = [
  { id: 'jewelry', name: 'Jewelry & Accessories' },
  { id: 'necklaces', name: 'Necklaces', parentId: 'jewelry' },
  { id: 'earrings', name: 'Earrings', parentId: 'jewelry' },
  { id: 'rings', name: 'Rings', parentId: 'jewelry' },
  { id: 'bags', name: 'Bags & Purses', parentId: 'jewelry' },
  { id: 'clothing', name: 'Clothing & Shoes' },
  { id: 'womens', name: "Women's Clothing", parentId: 'clothing' },
  { id: 'mens', name: "Men's Clothing", parentId: 'clothing' },
  { id: 'kids', name: "Kids' Clothing", parentId: 'clothing' },
  { id: 'shoes', name: 'Shoes', parentId: 'clothing' },
  { id: 'home', name: 'Home & Living' },
  { id: 'decor', name: 'Home Décor', parentId: 'home' },
  { id: 'kitchen', name: 'Kitchen & Dining', parentId: 'home' },
  { id: 'furniture', name: 'Furniture', parentId: 'home' },
  { id: 'lighting', name: 'Lighting', parentId: 'home' },
  { id: 'wedding', name: 'Wedding & Party' },
  { id: 'invitations', name: 'Invitations & Paper', parentId: 'wedding' },
  { id: 'party-decor', name: 'Party Décor', parentId: 'wedding' },
  { id: 'toys', name: 'Toys & Entertainment' },
  { id: 'art', name: 'Art & Collectibles' },
  { id: 'paintings', name: 'Paintings', parentId: 'art' },
  { id: 'prints', name: 'Prints', parentId: 'art' },
  { id: 'digital-art', name: 'Digital Downloads', parentId: 'art' },
  { id: 'craft-supplies', name: 'Craft Supplies & Tools' },
  { id: 'beads', name: 'Beads & Jewelry Making', parentId: 'craft-supplies' },
  { id: 'fabric', name: 'Fabric & Yarn', parentId: 'craft-supplies' },
  { id: 'vintage', name: 'Vintage' },
  { id: 'gifts', name: 'Gifts' },
];

export function categoryById(id: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

export function rootCategories(): Category[] {
  return CATEGORIES.filter((c) => !c.parentId);
}

export function childCategories(parentId: string): Category[] {
  return CATEGORIES.filter((c) => c.parentId === parentId);
}

/** The category plus all of its descendants. */
export function categoryTree(id: string): string[] {
  const ids = [id];
  for (const child of childCategories(id)) ids.push(...categoryTree(child.id));
  return ids;
}

export function categoryPath(id: string): Category[] {
  const path: Category[] = [];
  let current = categoryById(id);
  while (current) {
    path.unshift(current);
    current = current.parentId ? categoryById(current.parentId) : undefined;
  }
  return path;
}

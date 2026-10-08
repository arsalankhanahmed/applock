// Domain model shared by the server and the React client.
// All money values are integer cents to avoid floating point drift.

export type Role = 'user' | 'admin';

export interface Address {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  avatar?: string;
  bio?: string;
  role: Role;
  shopId?: string;
  address?: Address;
  suspended?: boolean;
  createdAt: string;
}

export type PublicUser = Omit<User, 'passwordHash'>;

export interface Session {
  token: string;
  userId: string;
  createdAt: string;
}

export interface ShopSection {
  id: string;
  name: string;
}

export interface ShopPolicies {
  processingDays: number;
  shipping: string;
  returns: string;
  acceptsReturns: boolean;
  returnWindowDays: number;
  privacy: string;
}

export interface Shop {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  tagline: string;
  about: string;
  announcement: string;
  location: string;
  logo?: string;
  banner?: string;
  sections: ShopSection[];
  policies: ShopPolicies;
  vacationMode: boolean;
  vacationMessage: string;
  adsDailyBudget: number;
  status: 'active' | 'suspended';
  createdAt: string;
}

export type ListingType = 'handmade' | 'vintage' | 'supplies';
export type ListingStatus = 'active' | 'draft' | 'sold_out' | 'inactive' | 'expired';

export interface VariationOption {
  value: string;
  priceDelta: number;
}

export interface Variation {
  name: string;
  options: VariationOption[];
}

export interface Personalization {
  enabled: boolean;
  required: boolean;
  instructions: string;
}

export interface ShippingInfo {
  cost: number;
  additionalItemCost: number;
  freeShipping: boolean;
  shipsFrom: string;
  processingDays: number;
}

export interface Listing {
  id: string;
  shopId: string;
  title: string;
  description: string;
  price: number;
  quantity: number;
  images: string[];
  categoryId: string;
  tags: string[];
  materials: string[];
  type: ListingType;
  isDigital: boolean;
  digitalFileUrl?: string;
  variations: Variation[];
  personalization: Personalization;
  shipping: ShippingInfo;
  sectionId?: string;
  status: ListingStatus;
  autoRenew: boolean;
  promoted: boolean;
  featured: boolean;
  views: number;
  createdAt: string;
  publishedAt?: string;
  expiresAt?: string;
}

export interface Favorite {
  userId: string;
  listingId: string;
  createdAt: string;
}

export interface ShopFavorite {
  userId: string;
  shopId: string;
  createdAt: string;
}

export interface Collection {
  id: string;
  userId: string;
  name: string;
  isPublic: boolean;
  listingIds: string[];
  createdAt: string;
}

export interface CartItem {
  id: string;
  userId: string;
  listingId: string;
  quantity: number;
  selections: Record<string, string>;
  personalization: string;
  savedForLater: boolean;
  createdAt: string;
}

export type DiscountType = 'percent' | 'fixed' | 'free_shipping';

export interface Promotion {
  id: string;
  shopId: string;
  kind: 'sale' | 'coupon';
  code?: string;
  discountType: DiscountType;
  value: number;
  minOrder: number;
  startsAt: string;
  endsAt?: string;
  active: boolean;
  timesUsed: number;
  createdAt: string;
}

export type OrderStatus = 'paid' | 'shipped' | 'delivered' | 'completed' | 'cancelled' | 'refunded';

export interface OrderItem {
  listingId: string;
  title: string;
  image?: string;
  unitPrice: number;
  quantity: number;
  selections: Record<string, string>;
  personalization: string;
  isDigital: boolean;
  digitalFileUrl?: string;
}

export interface OrderFees {
  transactionFee: number;
  processingFee: number;
  listingRenewalFees: number;
}

export interface Order {
  id: string;
  receiptNo: number;
  buyerId: string;
  shopId: string;
  items: OrderItem[];
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  couponCode?: string;
  isGift: boolean;
  giftMessage: string;
  noteToSeller: string;
  shippingAddress: Address;
  status: OrderStatus;
  tracking?: { carrier: string; number: string };
  fees: OrderFees;
  createdAt: string;
  shippedAt?: string;
  deliveredAt?: string;
  expectedShipBy: string;
}

export interface Review {
  id: string;
  orderId: string;
  listingId: string;
  shopId: string;
  buyerId: string;
  rating: number;
  text: string;
  image?: string;
  sellerReply?: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  buyerId: string;
  sellerId: string;
  shopId: string;
  listingId?: string;
  orderId?: string;
  subject: string;
  updatedAt: string;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  readBy: string[];
  createdAt: string;
}

export type LedgerType =
  | 'listing_fee'
  | 'sale'
  | 'shipping'
  | 'transaction_fee'
  | 'processing_fee'
  | 'ad_fee'
  | 'refund'
  | 'payout';

export interface LedgerEntry {
  id: string;
  shopId: string;
  type: LedgerType;
  amount: number;
  description: string;
  orderId?: string;
  listingId?: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  text: string;
  link: string;
  read: boolean;
  createdAt: string;
}

export interface Report {
  id: string;
  reporterId: string;
  targetType: 'listing' | 'shop' | 'review';
  targetId: string;
  reason: string;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt: string;
}

export interface AdClick {
  id: string;
  shopId: string;
  listingId: string;
  cost: number;
  createdAt: string;
}

export interface Database {
  users: User[];
  sessions: Session[];
  shops: Shop[];
  listings: Listing[];
  favorites: Favorite[];
  shopFavorites: ShopFavorite[];
  collections: Collection[];
  cart: CartItem[];
  promotions: Promotion[];
  orders: Order[];
  reviews: Review[];
  conversations: Conversation[];
  messages: Message[];
  ledger: LedgerEntry[];
  notifications: Notification[];
  reports: Report[];
  adClicks: AdClick[];
  counters: { receiptNo: number };
}

// ---- API view models -------------------------------------------------------

export interface ListingCard {
  id: string;
  title: string;
  price: number;
  salePrice?: number;
  image?: string;
  shopId: string;
  shopName: string;
  shopSlug: string;
  rating: number;
  reviewCount: number;
  freeShipping: boolean;
  isDigital: boolean;
  type: ListingType;
  promoted?: boolean;
  favorited?: boolean;
  starSeller?: boolean;
}

export interface ShopStats {
  sales: number;
  orderCount: number;
  rating: number;
  reviewCount: number;
  favorites: number;
  starSeller: boolean;
  onTimeShippingRate: number;
}

export interface CartShopGroup {
  shop: { id: string; name: string; slug: string; vacationMode: boolean };
  items: (CartItem & {
    listing: { id: string; title: string; image?: string; quantity: number; status: ListingStatus; isDigital: boolean };
    unitPrice: number;
    lineTotal: number;
  })[];
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  appliedPromotion?: { code?: string; label: string };
}

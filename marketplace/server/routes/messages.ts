import { Router } from 'express';
import { db, newId, now } from '../db.ts';
import { badRequest, handle, notFound, str } from '../http.ts';
import { requireUser } from '../auth.ts';
import { notify } from '../services.ts';
import type { Conversation, User } from '../../shared/types.ts';

export const messagesRouter = Router();

function participant(convo: Conversation, user: User): boolean {
  return convo.buyerId === user.id || convo.sellerId === user.id;
}

function conversationSummary(convo: Conversation, user: User) {
  const otherId = convo.buyerId === user.id ? convo.sellerId : convo.buyerId;
  const other = db.users.find((u) => u.id === otherId);
  const shop = db.shops.find((s) => s.id === convo.shopId);
  const messages = db.messages.filter((m) => m.conversationId === convo.id);
  const last = messages[messages.length - 1];
  return {
    ...convo,
    otherName: convo.sellerId === otherId ? `${shop?.name ?? 'Shop'} (${other?.name ?? ''})` : other?.name ?? 'Member',
    otherAvatar: convo.sellerId === otherId ? shop?.logo : other?.avatar,
    role: convo.buyerId === user.id ? 'buyer' : 'seller',
    lastMessage: last?.body ?? '',
    unread: messages.filter((m) => m.senderId !== user.id && !m.readBy.includes(user.id)).length,
  };
}

messagesRouter.get(
  '/conversations',
  handle((req) => {
    const user = requireUser(req);
    return db.conversations
      .filter((c) => participant(c, user))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => conversationSummary(c, user));
  }),
);

messagesRouter.get(
  '/conversations/:id',
  handle((req) => {
    const user = requireUser(req);
    const convo = db.conversations.find((c) => c.id === req.params.id);
    if (!convo || !participant(convo, user)) throw notFound('Conversation not found');
    const messages = db.messages.filter((m) => m.conversationId === convo.id);
    for (const m of messages) if (!m.readBy.includes(user.id)) m.readBy.push(user.id);
    const listing = convo.listingId ? db.listings.find((l) => l.id === convo.listingId) : undefined;
    const order = convo.orderId ? db.orders.find((o) => o.id === convo.orderId) : undefined;
    return {
      conversation: conversationSummary(convo, user),
      listing: listing ? { id: listing.id, title: listing.title, image: listing.images[0], price: listing.price } : undefined,
      order: order ? { id: order.id, receiptNo: order.receiptNo } : undefined,
      messages: messages.map((m) => ({ ...m, mine: m.senderId === user.id, senderName: db.users.find((u) => u.id === m.senderId)?.name })),
    };
  }),
);

// Writes a message and notifies the other participant. Called after the GET above has
// already marked messages read, so this doesn't touch read state for the sender.
function post(convo: Conversation, sender: User, body: string): void {
  db.messages.push({ id: newId('msg'), conversationId: convo.id, senderId: sender.id, body, readBy: [sender.id], createdAt: now() });
  convo.updatedAt = now();
  const recipient = convo.buyerId === sender.id ? convo.sellerId : convo.buyerId;
  notify(recipient, `New message from ${sender.name}: ${convo.subject}`, `/messages/${convo.id}`);
}

messagesRouter.post(
  '/conversations',
  handle((req) => {
    const user = requireUser(req);
    const shop = db.shops.find((s) => s.id === req.body.shopId);
    if (!shop) throw notFound('Shop not found');
    if (shop.ownerId === user.id) throw badRequest("You can't message your own shop");
    const body = str(req.body.body, 'Message', { required: true, max: 5000 });
    const listingId = typeof req.body.listingId === 'string' ? req.body.listingId : undefined;
    const orderId = typeof req.body.orderId === 'string' ? req.body.orderId : undefined;
    let convo = db.conversations.find((c) => c.buyerId === user.id && c.shopId === shop.id && c.listingId === listingId && c.orderId === orderId);
    if (!convo) {
      const listing = listingId ? db.listings.find((l) => l.id === listingId) : undefined;
      convo = {
        id: newId('cnv'),
        buyerId: user.id,
        sellerId: shop.ownerId,
        shopId: shop.id,
        listingId,
        orderId,
        subject: str(req.body.subject, 'Subject', { max: 120 }) || (listing ? `About: ${listing.title}` : `Message to ${shop.name}`),
        createdAt: now(),
        updatedAt: now(),
      };
      db.conversations.push(convo);
    }
    post(convo, user, body);
    return { id: convo.id };
  }),
);

messagesRouter.post(
  '/conversations/:id/messages',
  handle((req) => {
    const user = requireUser(req);
    const convo = db.conversations.find((c) => c.id === req.params.id);
    if (!convo || !participant(convo, user)) throw notFound('Conversation not found');
    post(convo, user, str(req.body.body, 'Message', { required: true, max: 5000 }));
  }),
);

# Otopair Developer Next Steps

The backend foundation is now in place. Here's what to do next, in priority order.

---

## 1. Clerk Dashboard Setup (Do First)

- [ ] **Create a JWT template named `convex`** in Clerk Dashboard > JWT Templates
  - Template name: `convex`
  - Claims: `{ "metadata": "{{user.public_metadata}}" }`
- [ ] **Create a webhook endpoint** in Clerk Dashboard > Webhooks
  - URL: `https://your-domain.com/api/webhooks/clerk`
  - Events: `user.created`, `user.updated`, `user.deleted`
  - Copy the signing secret to `CLERK_WEBHOOK_SIGNING_SECRET` in `.env.local`
- [ ] **Test locally** with ngrok or Clerk's webhook testing tool
- [ ] **Assign roles** to test users via Clerk Dashboard > Users > Edit > Public Metadata:
  ```json
  { "role": "shop_owner" }
  ```
  Valid roles: `user`, `shop_owner`, `mechanic`, `admin`

## 2. Convex Setup

- [ ] Run `npx convex dev` to push the schema and generate types
- [ ] Verify tables appear in the Convex Dashboard: `users`, `shops`, `shop_users`, `time_slots`, `jobs`
- [ ] Add `CLERK_WEBHOOK_SIGNING_SECRET` to Convex environment variables if using Convex actions for webhooks

## 3. Shop Onboarding Flow

- [ ] Build the shop setup form at `/shop/setup`
  - Fields: name, slug, address, city, state, zip, phone
  - On submit: call `api.shops.create` mutation
  - On success: redirect to `/dashboard`
- [ ] Add slug validation (unique, URL-safe)
- [ ] Update the `/shop` page to show shop details when a shop exists

## 4. Mechanic Invitation System

- [ ] Add an invite form to `/team` page
- [ ] Use Clerk Invitations API to send email invites
- [ ] On `user.created` webhook, check if the new user was invited → auto-create `shop_users` junction entry
- [ ] Build accept/decline flow for invitations

## 5. Job Management CRUD

- [ ] Create Convex mutations: `jobs.create`, `jobs.update`, `jobs.accept`, `jobs.complete`, `jobs.cancel`
- [ ] Build job creation form (customer or shop-initiated)
- [ ] Build job detail view with status transitions
- [ ] Add job assignment (shop owner assigns mechanic)

## 6. Schedule & Time Slot Builder

- [ ] Build calendar UI at `/schedule`
- [ ] Create Convex mutations: `timeSlots.create`, `timeSlots.update`, `timeSlots.toggleAvailability`
- [ ] Support recurring schedule templates
- [ ] Link time slots to job bookings

## 7. Admin Data Tables

- [ ] Add data tables at `/admin/users`, `/admin/shops` with search/filter
- [ ] Create admin Convex queries: `admin.getAllUsers`, `admin.getAllShops`, `admin.getAllJobs`
- [ ] Add role management (change user roles from admin panel)
- [ ] Add shop approval/deactivation controls

## 8. Payments & Payouts

- [ ] Integrate Stripe Connect for shop payouts
- [ ] Add payment collection on job completion
- [ ] Build invoice/receipt generation

## 9. Future Considerations

- [ ] Split admin to a separate subdomain if admin team grows
- [ ] Add real-time notifications (Convex subscriptions)
- [ ] Build the consumer-facing booking app
- [ ] Add analytics dashboard

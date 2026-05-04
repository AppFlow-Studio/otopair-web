export interface Shop {
  id: string
  name: string
  city: string
  status: 'active' | 'pending' | 'suspended'
  mechanics: number
  bookings7d: number
  stripe: boolean
  lastActivity: string
  tier: 'Premium' | 'Standard'
  notifications: boolean
  payoutSchedule: string
}

export interface User {
  id: string
  name: string
  email: string
  phone: string
  vehicles: number
  bookings: number
  lastBooking: string
  loyalty: 'elite' | 'premium' | 'standard'
  joined: string
}

export interface Booking {
  id: string
  user: string
  shop: string
  service: string
  time: string
  scheduled: string
  status: 'confirmed' | 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'refunded'
  total: number
  mechanic: string
  refundReason?: string
}

export interface Bug {
  id: string
  title: string
  source: 'consumer_ios' | 'consumer_android' | 'shop_web' | 'manual'
  version: string
  device: string
  age: string
  assignee: string | null
}

export interface FeedbackItem {
  id: string
  title: string
  category: 'feature_request' | 'ux' | 'shop_quality' | 'general' | 'praise'
  sentiment: 'positive' | 'negative' | 'neutral'
  source: string
  age: string
  autoIngested?: boolean
  ratingShop?: string
}

export interface AuditEntry {
  timestamp: string
  action: string
  actor: string
  detail: string
  entity?: string
}

export interface Note {
  author: string
  when: string
  text: string
  system?: boolean
}

export interface Refund {
  id: string
  shop: string
  amount: number
  date: string
}

export const SHOPS: Shop[] = [
  { id:'shp_a91', name:'Pacific Auto Care',      city:'San Francisco, CA', status:'active',    mechanics:8, bookings7d:47, stripe:true,  lastActivity:'2m ago',   tier:'Premium',  notifications:true,  payoutSchedule:'Daily' },
  { id:'shp_b12', name:'Mission Tire & Wheel',   city:'San Francisco, CA', status:'active',    mechanics:5, bookings7d:31, stripe:true,  lastActivity:'14m ago',  tier:'Standard', notifications:true,  payoutSchedule:'Weekly (Mon)' },
  { id:'shp_c33', name:'Bayview Brake Shop',     city:'Oakland, CA',       status:'active',    mechanics:6, bookings7d:28, stripe:true,  lastActivity:'1h ago',   tier:'Premium',  notifications:true,  payoutSchedule:'Daily' },
  { id:'shp_d44', name:'Sunset Auto Body',       city:'San Francisco, CA', status:'pending',   mechanics:3, bookings7d:0,  stripe:false, lastActivity:'2d ago',   tier:'Standard', notifications:false, payoutSchedule:'—' },
  { id:'shp_e55', name:'Marina Garage',          city:'San Francisco, CA', status:'active',    mechanics:4, bookings7d:19, stripe:true,  lastActivity:'23m ago',  tier:'Standard', notifications:true,  payoutSchedule:'Weekly (Fri)' },
  { id:'shp_f66', name:'Berkeley Foreign Auto',  city:'Berkeley, CA',      status:'active',    mechanics:7, bookings7d:22, stripe:true,  lastActivity:'3h ago',   tier:'Premium',  notifications:true,  payoutSchedule:'Daily' },
  { id:'shp_g77', name:'East Bay Diesel',        city:'Hayward, CA',       status:'suspended', mechanics:2, bookings7d:0,  stripe:true,  lastActivity:'11d ago',  tier:'Standard', notifications:false, payoutSchedule:'Paused' },
  { id:'shp_h88', name:'Peninsula Tire Pros',    city:'Daly City, CA',     status:'active',    mechanics:5, bookings7d:24, stripe:true,  lastActivity:'6m ago',   tier:'Standard', notifications:true,  payoutSchedule:'Weekly (Mon)' },
  { id:'shp_i99', name:'Goldenrod Motors',       city:'San Mateo, CA',     status:'pending',   mechanics:4, bookings7d:2,  stripe:false, lastActivity:'4d ago',   tier:'Standard', notifications:true,  payoutSchedule:'—' },
  { id:'shp_j10', name:'Chelala Service Center', city:'San Francisco, CA', status:'active',    mechanics:9, bookings7d:53, stripe:true,  lastActivity:'just now', tier:'Premium',  notifications:true,  payoutSchedule:'Daily' },
]

export const USERS: User[] = [
  { id:'usr_001', name:'Daniel Chelala',  email:'daniel.c@gmail.com',    phone:'+1 (415) 555-0182', vehicles:2, bookings:14, lastBooking:'Apr 28', loyalty:'elite',    joined:'Jan 2024' },
  { id:'usr_002', name:'Jordan Park',     email:'jpark@hotmail.com',      phone:'+1 (415) 555-0244', vehicles:1, bookings:8,  lastBooking:'Apr 27', loyalty:'premium',  joined:'Mar 2024' },
  { id:'usr_003', name:'Taylor Brooks',   email:'tbrooks@yahoo.com',      phone:'+1 (510) 555-0319', vehicles:2, bookings:6,  lastBooking:'Apr 25', loyalty:'premium',  joined:'May 2024' },
  { id:'usr_004', name:'Maria Gonzalez',  email:'maria.g@outlook.com',    phone:'+1 (650) 555-0467', vehicles:1, bookings:3,  lastBooking:'Apr 20', loyalty:'standard', joined:'Jan 2025' },
  { id:'usr_005', name:'Aiden Nakamura',  email:'aiden.n@gmail.com',      phone:'+1 (415) 555-0521', vehicles:1, bookings:11, lastBooking:'Apr 29', loyalty:'elite',    joined:'Aug 2023' },
  { id:'usr_006', name:'Priya Shah',      email:'priya.shah@icloud.com',  phone:'+1 (510) 555-0688', vehicles:1, bookings:2,  lastBooking:'Apr 18', loyalty:'standard', joined:'Feb 2025' },
  { id:'usr_007', name:'Marcus Holloway', email:'mholloway@gmail.com',    phone:'+1 (415) 555-0744', vehicles:3, bookings:19, lastBooking:'Apr 28', loyalty:'elite',    joined:'Sep 2023' },
  { id:'usr_008', name:'Elena Rossi',     email:'erossi@gmail.com',       phone:'+1 (650) 555-0801', vehicles:1, bookings:5,  lastBooking:'Apr 22', loyalty:'standard', joined:'Nov 2024' },
]

export const BOOKINGS: Booking[] = [
  { id:'BKG-9412', user:'Daniel Chelala',  shop:'Pacific Auto Care',      service:'Oil Change + Tire Rotation', time:'9:30 AM',  scheduled:'Today',  status:'confirmed',   total:124.50, mechanic:'Luis Ortega' },
  { id:'BKG-9413', user:'Jordan Park',     shop:'Mission Tire & Wheel',   service:'Tire Replacement (4)',       time:'10:00 AM', scheduled:'Today',  status:'in_progress', total:892.00, mechanic:'Marco Bianchi' },
  { id:'BKG-9414', user:'Taylor Brooks',   shop:'Bayview Brake Shop',     service:'Front Brake Pads',           time:'10:45 AM', scheduled:'Today',  status:'confirmed',   total:348.75, mechanic:'Wei Zhang' },
  { id:'BKG-9415', user:'Maria Gonzalez',  shop:'Marina Garage',          service:'Diagnostic',                 time:'11:30 AM', scheduled:'Today',  status:'pending',     total:95.00,  mechanic:'—' },
  { id:'BKG-9416', user:'Aiden Nakamura',  shop:'Berkeley Foreign Auto',  service:'AC System Service',          time:'12:15 PM', scheduled:'Today',  status:'confirmed',   total:410.00, mechanic:'Erik Sundberg' },
  { id:'BKG-9417', user:'Priya Shah',      shop:'Peninsula Tire Pros',    service:'Wheel Alignment',            time:'1:00 PM',  scheduled:'Today',  status:'in_progress', total:159.00, mechanic:'Sam Reilly' },
  { id:'BKG-9418', user:'Marcus Holloway', shop:'Pacific Auto Care',      service:'Battery Replacement',        time:'2:00 PM',  scheduled:'Today',  status:'pending',     total:278.00, mechanic:'—' },
  { id:'BKG-9419', user:'Elena Rossi',     shop:'Chelala Service Center', service:'60K Mile Service',           time:'2:30 PM',  scheduled:'Today',  status:'confirmed',   total:645.00, mechanic:'Daniel Chelala' },
  { id:'BKG-9420', user:'Sofia Martinez',  shop:'Mission Tire & Wheel',   service:'Tire Patch',                 time:'3:15 PM',  scheduled:'Today',  status:'confirmed',   total:45.00,  mechanic:'Marco Bianchi' },
  { id:'BKG-9421', user:'Ben Greer',       shop:'Bayview Brake Shop',     service:'Brake Inspection',           time:'4:00 PM',  scheduled:'Today',  status:'pending',     total:0,      mechanic:'—' },
  { id:'BKG-9388', user:'Hiro Tanaka',     shop:'Pacific Auto Care',      service:'Oil Change',                 time:'—',        scheduled:'Apr 27', status:'completed',   total:79.00,  mechanic:'Luis Ortega' },
  { id:'BKG-9376', user:'Olivia Brennan',  shop:'Marina Garage',          service:'Diagnostic',                 time:'—',        scheduled:'Apr 26', status:'refunded',    total:95.00,  mechanic:'James Whittaker', refundReason:'service_quality' },
]

export const BUGS: Record<string, Bug[]> = {
  new: [
    { id:'BUG-241', title:'Map markers stutter when zooming out past city level',           source:'consumer_ios',     version:'iOS 2.4.1',     device:'iPhone 14 Pro', age:'12m ago', assignee:null },
    { id:'BUG-240', title:'Booking confirmation push not received after stripe payment',     source:'consumer_android', version:'Android 2.3.8', device:'Pixel 8',       age:'47m ago', assignee:null },
    { id:'BUG-239', title:'Quote countdown timer resets on app background → foreground',    source:'consumer_ios',     version:'iOS 2.4.1',     device:'iPhone 15',     age:'1h ago',  assignee:null },
    { id:'BUG-238', title:'Shop dashboard: "Pending acceptance" count off by one',          source:'shop_web',         version:'web 1.12.0',    device:'Chrome 124',    age:'2h ago',  assignee:null },
  ],
  triaged: [
    { id:'BUG-235', title:'VIN scanner crashes on glare from windshield',                   source:'consumer_ios',     version:'iOS 2.4.0',     device:'iPhone 13',     age:'5h ago',  assignee:'Waleed' },
    { id:'BUG-232', title:'Email receipt missing line item for shop tip',                   source:'manual',           version:'—',             device:'—',             age:'8h ago',  assignee:'Daniel' },
  ],
  assigned: [
    { id:'BUG-228', title:'Tire size selector doubles up on rapid taps',                    source:'consumer_android', version:'Android 2.3.7', device:'Samsung S23',   age:'1d ago',  assignee:'Priya' },
    { id:'BUG-225', title:'Settings → Add Card flow loops back to home unexpectedly',       source:'consumer_ios',     version:'iOS 2.4.0',     device:'iPhone 12',     age:'1d ago',  assignee:'Marcus' },
  ],
  in_progress: [
    { id:'BUG-219', title:'Shop CRM: bookings list pagination breaks at page 4+',           source:'shop_web',         version:'web 1.11.4',    device:'Safari 17',     age:'2d ago',  assignee:'Daniel' },
    { id:'BUG-216', title:'Apple Pay button shows briefly then disappears at checkout',     source:'consumer_ios',     version:'iOS 2.4.0',     device:'iPhone 15 Pro', age:'2d ago',  assignee:'Waleed' },
    { id:'BUG-212', title:'Address autocomplete returns no results for some Oakland zips',  source:'consumer_android', version:'Android 2.3.7', device:'Pixel 7a',      age:'3d ago',  assignee:'Priya' },
    { id:'BUG-209', title:'Refund confirmation email goes to spam (Gmail)',                 source:'manual',           version:'—',             device:'—',             age:'3d ago',  assignee:'Marcus' },
  ],
  done: [
    { id:'BUG-204', title:'Map pin label overlaps shop rating stars',                       source:'consumer_ios',     version:'iOS 2.3.9',     device:'iPhone 14',     age:'5d ago',  assignee:'Waleed' },
    { id:'BUG-201', title:'Quote expiration time off by timezone for non-PST users',        source:'consumer_android', version:'Android 2.3.6', device:'Pixel 8',       age:'6d ago',  assignee:'Priya' },
  ],
  verified: [
    { id:'BUG-198', title:'Booking history sort defaults to oldest-first',                  source:'consumer_ios',     version:'iOS 2.3.9',     device:'iPhone 13 mini',age:'8d ago',  assignee:'Daniel' },
    { id:'BUG-195', title:'Stripe webhook retry storm during outage on Apr 18',             source:'manual',           version:'—',             device:'—',             age:'10d ago', assignee:'Marcus' },
  ],
}

export const FEEDBACK: Record<string, FeedbackItem[]> = {
  new: [
    { id:'FB-512', title:'1-star review: "Wait for quotes was way too long, gave up"', category:'shop_quality',    sentiment:'negative', source:'rating_comment',   age:'8m ago',  autoIngested:true, ratingShop:'East Bay Diesel' },
    { id:'FB-511', title:'Add option to save preferred mechanic across bookings',       category:'feature_request', sentiment:'positive', source:'consumer_ios',     age:'34m ago' },
    { id:'FB-510', title:'Bookings tab tap target too small on small phones',           category:'ux',              sentiment:'neutral',  source:'consumer_ios',     age:'2h ago' },
    { id:'FB-509', title:'Love the live tracker — felt like Uber for my car',           category:'praise',          sentiment:'positive', source:'email',            age:'4h ago' },
  ],
  reviewed: [
    { id:'FB-505', title:'Show estimated drop-off ETA in confirmation email',           category:'feature_request', sentiment:'positive', source:'consumer_android', age:'1d ago' },
    { id:'FB-503', title:'Allow editing tire quantity after quote received',             category:'feature_request', sentiment:'neutral',  source:'consumer_ios',     age:'1d ago' },
  ],
  triaged:   [{ id:'FB-498', title:'Shop quality concern: cleanliness at Goldenrod Motors', category:'shop_quality', sentiment:'negative', source:'manual', age:'2d ago' }],
  planned:   [
    { id:'FB-491', title:'Multi-vehicle households: show garage on home screen', category:'feature_request', sentiment:'positive', source:'consumer_ios',     age:'4d ago' },
    { id:'FB-487', title:'Light/dark mode toggle in settings',                   category:'ux',              sentiment:'neutral',  source:'consumer_android', age:'5d ago' },
  ],
  done:      [{ id:'FB-478', title:'Quotes screen: side-by-side comparison was huge', category:'praise',          sentiment:'positive', source:'rating_comment', age:'9d ago' }],
  wontfix:   [{ id:'FB-465', title:'Add support for motorcycle tires',                category:'feature_request', sentiment:'neutral',  source:'email',          age:'2w ago' }],
  duplicate: [{ id:'FB-460', title:'Reset password email never arrives',              category:'general',         sentiment:'negative', source:'manual',         age:'2w ago' }],
}

export const REFUNDS: Refund[] = [
  { id:'BKG-9376', shop:'Marina Garage',       amount:95.00,  date:'Apr 26' },
  { id:'BKG-9341', shop:'Sunset Auto Body',     amount:240.00, date:'Apr 24' },
  { id:'BKG-9298', shop:'East Bay Diesel',      amount:412.50, date:'Apr 21' },
  { id:'BKG-9277', shop:'Pacific Auto Care',    amount:56.00,  date:'Apr 20' },
  { id:'BKG-9251', shop:'Mission Tire & Wheel', amount:178.25, date:'Apr 18' },
]

export const STRIPE_ACCOUNTS = SHOPS.slice(0, 5).map(s => ({
  name: s.name,
  status: s.stripe ? 'connected' : 'not_connected',
  schedule: s.payoutSchedule,
}))

export const COUNTERS = {
  active_bookings: 47,
  bookings_today: 112,
  total_bookings: 8429,
  active_shops: 38,
  active_users: 2147,
  open_bugs: 23,
  open_feedback: 41,
  pending_mechanic_edits: 7,
  untagged_refunds: 5,
}

export const BOOKING_HISTORY = [
  { stage:'pending',     time:'Apr 28, 9:02 AM',  by:'system' },
  { stage:'confirmed',   time:'Apr 28, 9:08 AM',  by:'Pacific Auto Care' },
  { stage:'in_progress', time:'Apr 28, 9:34 AM',  by:'Luis Ortega' },
  { stage:'completed',   time:'Apr 28, 10:21 AM', by:'Luis Ortega' },
]

export const SHOP_AUDIT: AuditEntry[] = [
  { timestamp:'Apr 29, 3:01 PM',  action:'note_added',     actor:'Temur AB',       detail:'Internal note added (112 chars)' },
  { timestamp:'Apr 29, 11:42 AM', action:'field_edit',     actor:'Daniel Chelala', detail:'Auto-accept threshold raised from $200 → $300' },
  { timestamp:'Apr 28, 9:17 AM',  action:'payout_sent',    actor:'system',         detail:'Stripe payout $1,892.00 settled to acct_1Q9k…cE3' },
  { timestamp:'Apr 26, 2:30 PM',  action:'mechanic_added', actor:'Daniel Chelala', detail:'Erik Sundberg added as Mechanic' },
  { timestamp:'Apr 18, 5:50 PM',  action:'tier_change',    actor:'Temur AB',       detail:'Pricing tier upgraded Standard → Premium' },
  { timestamp:'Mar 02, 10:14 AM', action:'flag_raised',    actor:'system',         detail:'Stripe Connect onboarding completed · payouts enabled' },
  { timestamp:'Feb 14, 9:02 AM',  action:'shop_created',   actor:'system',         detail:'Shop onboarded via partner application' },
]

export const USER_AUDIT: AuditEntry[] = [
  { timestamp:'Apr 29, 2:12 PM',  action:'note_added',    actor:'Temur AB',       detail:'Log entry added (98 chars)' },
  { timestamp:'Apr 29, 2:08 PM',  action:'viewed',        actor:'Temur AB',       detail:'Profile opened from Users table' },
  { timestamp:'Apr 28, 11:14 AM', action:'email_sent',    actor:'system',         detail:'Password reset email sent to user' },
  { timestamp:'Apr 28, 11:13 AM', action:'field_edit',    actor:'Temur AB',       detail:'Reset password requested · reason: support ticket #4421' },
  { timestamp:'Apr 22, 4:02 PM',  action:'refund_issued', actor:'Daniel Chelala', detail:'$25.00 goodwill credit applied · BKG-9341' },
  { timestamp:'Apr 22, 3:58 PM',  action:'flag_raised',   actor:'system',         detail:'No-show flagged on BKG-9341 (Marina Garage)' },
  { timestamp:'Jan 14, 10:02 AM', action:'field_edit',    actor:'system',         detail:'Account created via consumer iOS · email verified' },
]

export const BOOKING_AUDIT: AuditEntry[] = [
  { timestamp:'Apr 28, 10:21 AM', action:'status_change',    actor:'Luis Ortega',       detail:'Status changed from in_progress → completed' },
  { timestamp:'Apr 28, 10:18 AM', action:'note_added',       actor:'Temur AB',          detail:'Log entry added (43 chars)' },
  { timestamp:'Apr 28, 9:34 AM',  action:'status_change',    actor:'Luis Ortega',       detail:'Status changed from confirmed → in_progress' },
  { timestamp:'Apr 28, 9:08 AM',  action:'assignee_change',  actor:'Pacific Auto Care', detail:'Mechanic assigned: Luis Ortega' },
  { timestamp:'Apr 28, 9:08 AM',  action:'status_change',    actor:'Pacific Auto Care', detail:'Status changed from pending → confirmed' },
  { timestamp:'Apr 28, 9:02 AM',  action:'payment_captured', actor:'system',            detail:'Stripe payment captured · pi_3QkR…7Lb · $124.50' },
  { timestamp:'Apr 28, 9:02 AM',  action:'email_sent',       actor:'system',            detail:'Booking confirmation email sent to daniel.c@gmail.com' },
  { timestamp:'Apr 28, 9:01 AM',  action:'field_edit',       actor:'Daniel Chelala',    detail:'Booking created via consumer iOS 2.4.1' },
]

export const BUG_AUDIT: AuditEntry[] = [
  { timestamp:'Apr 29, 1:42 PM',  action:'note_added',      actor:'Priya',          detail:'Log entry added (78 chars)' },
  { timestamp:'Apr 29, 1:38 PM',  action:'assignee_change', actor:'Daniel Chelala', detail:'Assigned to Waleed → reassigned to Priya' },
  { timestamp:'Apr 29, 11:02 AM', action:'status_change',   actor:'Daniel Chelala', detail:'Status changed from triaged → assigned' },
  { timestamp:'Apr 29, 10:14 AM', action:'status_change',   actor:'Temur AB',       detail:'Status changed from new → triaged' },
  { timestamp:'Apr 29, 9:47 AM',  action:'flag_raised',     actor:'system',         detail:'Auto-ingested from consumer Android crash report' },
]

export const FB_AUDIT: AuditEntry[] = [
  { timestamp:'Apr 29, 11:34 AM', action:'note_added',  actor:'Daniel Chelala', detail:'Log entry added (124 chars)' },
  { timestamp:'Apr 29, 11:08 AM', action:'field_edit',  actor:'Temur AB',       detail:'Sentiment set to negative' },
  { timestamp:'Apr 29, 11:08 AM', action:'field_edit',  actor:'Temur AB',       detail:'Category set to shop_quality' },
  { timestamp:'Apr 29, 10:42 AM', action:'flag_raised', actor:'system',         detail:'Auto-ingested · 1★ rating comment for East Bay Diesel' },
]

export const AUDIT_ENTRIES: AuditEntry[] = [
  { timestamp:'Apr 29, 3:42 PM',  action:'refund_issued',    actor:'Temur AB',       entity:'BKG-9412 · Sunrise Auto',    detail:'Refund of $187.50 issued (reason: customer_no_show)' },
  { timestamp:'Apr 29, 3:39 PM',  action:'refund_tagged',    actor:'Temur AB',       entity:'BKG-9412 · Sunrise Auto',    detail:'Reason set to customer_no_show' },
  { timestamp:'Apr 29, 3:31 PM',  action:'payment_captured', actor:'system',         entity:'BKG-9418 · Marina Garage',   detail:'Captured $312.00 via Stripe (pi_3OkL2x...)' },
  { timestamp:'Apr 29, 3:18 PM',  action:'note_added',       actor:'Daniel Chelala', entity:'USR-1043 · Jamie Reyes',     detail:'Internal note added (124 chars)' },
  { timestamp:'Apr 29, 3:02 PM',  action:'status_change',    actor:'Luis Ortega',    entity:'BUG-417 · Push notif iOS',   detail:'Status: in_progress → in_review' },
  { timestamp:'Apr 29, 2:58 PM',  action:'email_sent',       actor:'system',         entity:'USR-1043 · Jamie Reyes',     detail:'Receipt email dispatched (template: refund_v3)' },
  { timestamp:'Apr 29, 2:51 PM',  action:'flag_raised',      actor:'system',         entity:'SHOP-East Bay Diesel',       detail:'Negative-review threshold tripped (3 in 24h)' },
  { timestamp:'Apr 29, 2:42 PM',  action:'assignee_change',  actor:'Temur AB',       entity:'BUG-415 · Calendar sync',    detail:'Assignee: unassigned → Priya Shah' },
  { timestamp:'Apr 29, 2:31 PM',  action:'field_edit',       actor:'Daniel Chelala', entity:'SHOP-Marina Garage',         detail:'Updated payout schedule: weekly → daily' },
  { timestamp:'Apr 29, 2:14 PM',  action:'viewed',           actor:'Temur AB',       entity:'USR-1043 · Jamie Reyes',     detail:'Opened user record (PII access logged)' },
  { timestamp:'Apr 29, 1:58 PM',  action:'note_added',       actor:'Priya',          entity:'BUG-417 · Push notif iOS',   detail:'Internal note added (78 chars)' },
  { timestamp:'Apr 29, 1:42 PM',  action:'payment_captured', actor:'system',         entity:'BKG-9410 · Castro Motors',   detail:'Captured $94.20 via Stripe (pi_3OkKzh...)' },
  { timestamp:'Apr 29, 1:31 PM',  action:'status_change',    actor:'system',         entity:'BKG-9408 · Sunrise Auto',    detail:'Auto-completed after 24h post-service window' },
  { timestamp:'Apr 29, 1:18 PM',  action:'refund_tagged',    actor:'Daniel Chelala', entity:'BKG-9402 · East Bay Diesel', detail:'Reason set to service_quality' },
  { timestamp:'Apr 29, 1:02 PM',  action:'email_sent',       actor:'system',         entity:'USR-1041 · Sam Okafor',      detail:'Booking reminder dispatched (24h pre-appt)' },
  { timestamp:'Apr 29, 12:48 PM', action:'note_added',       actor:'Temur AB',       entity:'BKG-9395 · Marina Garage',   detail:'Internal note added (98 chars)' },
  { timestamp:'Apr 29, 12:31 PM', action:'flag_raised',      actor:'system',         entity:'BKG-9393 · Castro Motors',   detail:'Mechanic checked in 47min late (threshold: 30min)' },
  { timestamp:'Apr 29, 12:14 PM', action:'field_edit',       actor:'Temur AB',       entity:'SHOP-East Bay Diesel',       detail:'Verification status: pending → approved' },
]

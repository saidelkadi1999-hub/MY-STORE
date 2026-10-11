# CÂLINE — تفعيل Stripe (الدفع الحقيقي)

نظام دفع حقيقي عبر **Stripe Checkout** (بلا أي محاكاة). الطلب كيتسجّل فـSupabase **فقط بعد نجاح الدفع** عبر Webhook.

## ⚠️ مهم: طريقة النشر
الـNetlify Functions كتحتاج تثبيت تبعيات (stripe + supabase). إذن **خاص النشر عبر GitHub** (ماشي السحب اليدوي):
- اربط المشروع بمستودع GitHub، ثم اربط المستودع بـNetlify.
- Netlify غادي يقرا `netlify.toml`، يثبّت `package.json`، يبني الـfunctions، وينشر مجلد `site`.

## 1) شغّل الـSQL
Supabase → SQL Editor → شغّل **`caline-stripe-schema.sql`**
(كيزيد جدول transit `checkout_payloads` + دالة `create_paid_order` الذرّية + فهرس idempotency.)

## 2) المتغيّرات السرّية فـNetlify
Netlify → Site settings → **Environment variables** → زيد:

| المتغيّر | القيمة | من فين |
|---------|--------|--------|
| `STRIPE_SECRET_KEY` | `sk_live_...` (أو `sk_test_...`) | Stripe → Développeurs → Clés API → **Clé secrète** |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | من إعداد الـWebhook (خطوة 4) |
| `SUPABASE_URL` | `https://VOTRE-PROJET-SUPABASE.supabase.co` | Supabase → API |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` السرّي | Supabase → API → **service_role** |
| `SITE_URL` (اختياري) | `https://calineanimal.netlify.app` | رابط موقعك |

> 🔒 المفتاح السرّي ديال Stripe و`service_role` ديال Supabase **كيبقاو هنا فقط** — ماشي فالكود.

## 3) المفتاح القابل للنشر (الواجهة)
فـ`caline-config.js` عمّر:
```js
window.CALINE_STRIPE = { publishableKey: "pk_live_..." };
```
(من Stripe → Clés API → **Clé publiable**.)

## 4) صاوب الـWebhook فـStripe
Stripe → **Développeurs** → **Webhooks** → **Add endpoint**:
- URL: `https://VOTRE-SITE.netlify.app/.netlify/functions/stripe-webhook`
- Événement: **`checkout.session.completed`**
- بعد الإنشاء، انسخ **Signing secret** (`whsec_...`) → حطّو فـNetlify كـ`STRIPE_WEBHOOK_SECRET`.

## كيفاش كيخدم (التدفّق)
1. العميل كيعمّر checkout → كيضغط **Payer XX €**
2. الواجهة كتصيفط السلة + بيانات العميل لـ`create-checkout-session`
3. الـFunction **كتعاود تحسب الأثمنة من Supabase** (أمان ضد التلاعب)، كتسجّل الـpayload فـtransit، كتصاوب جلسة Stripe، كترجّع الرابط
4. العميل كيتحوّل لصفحة **Stripe الآمنة** ويخلّص
5. عند **النجاح فقط**: Stripe كيصيفط webhook → الـFunction كتأكّد التوقيع → كتنادي `create_paid_order` اللي:
   - تنشئ Order (status=**paid**) + Order Items
   - تخصم المخزون
   - تسجّل `stripe_session_id` + `stripe_payment_intent`
6. العميل كيرجع لصفحة **Merci** (السلة كتتمسح)
7. الطلب كيبان فوراً فلوحة **admin-orders.html** ✅

عند **فشل الدفع**: ماكيتصيفطش webhook النجاح → **ماكيتصاوب حتى Order** (بلا أي طلب وهمي).

## اختبار (موصى به: وضع Test)
- استعمل مفاتيح `sk_test_` + `pk_test_`
- بطاقة تجريبية: `4242 4242 4242 4242` · تاريخ مستقبلي · أي CVC
- بعد الدفع → خاصك تشوف الطلب فـ`admin-orders.html` بحالة **Payée**

## الملفات الجديدة/المعدّلة
- جديد: `netlify.toml` · `package.json` · `netlify/functions/create-checkout-session.js` · `netlify/functions/stripe-webhook.js` · `site/merci.html` · `db/caline-stripe-schema.sql`
- معدّل (تعديل أدنى فقط): `site/checkout.html` (دالة `startPayment` + Stripe.js) · `site/caline-config.js` (مفتاح Stripe القابل للنشر)
- التصميم واللوحات: **ماتقيّسوش**.

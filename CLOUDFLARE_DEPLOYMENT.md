# ⚡ دليل النشر السريع والمثالي على كلاود فلاير (Cloudflare Deployment Guide)

يمتلك تطبيق **Omegooo** توافقاً كاملاً ورائعاً مع شبكة **Cloudflare**، حيث يدعم التعرف التلقائي على عنوان IP الحقيقي عبر ترويسة `CF-Connecting-IP` وبث الـ WebSockets المباشر للدردشة المرئية والكتابية.

---

## 🚀 الطرق الثلاث الموصى بها للنشر عبر Cloudflare

### 🌟 الطريقة الأولى: استخدام نفق كلاود فلاير مجاناً (Cloudflare Tunnel - Zero Trust) - [الأسهل والأفضل]

هذه الطريقة تتيح لك تشغيل خادم التطبيق (على خادمك الخاص VPS، أو Docker، أو أي استضافة) وربطه مباشرة بدومينك على Cloudflare دون الحاجة لفتح منافذ (Port Forwarding) وبأعلى مستويات الأمان.

#### الخطوات:
1. **إنشاء النفق في لوحة Cloudflare**:
   - توجه إلى لوحة تحكم **Cloudflare Zero Trust** -> **Networks** -> **Tunnels**.
   - اضغط على **Add a Tunnel** واختر **cloudflared**.
   - اختر اسماً للنفق وانسخ رمز النفق الخاص بك (`TUNNEL_TOKEN`).

2. **التشغيل بضغطة زر واحدة عبر Docker Compose**:
   - افتح ملف `docker-compose.yml` وفك التعليق عن خادم `cloudflared`.
   - قم بتشغيل الأمر التالي في المجلد الرئيسي:
     ```bash
     export CLOUDFLARE_TUNNEL_TOKEN="توكن_النفق_الخاص_بك"
     docker-compose up -d
     ```

3. **توجيه النطاق (Public Hostname)**:
   - في إعدادات النفق داخل كلاود فلاير، أضف Public Hostname:
     - **Subdomain / Domain**: اختر نطاقك (مثال: `chat.yourdomain.com`).
     - **Service Type**: `HTTP`
     - **URL**: `app:3000` (أو `localhost:3000`).

---

### 🌐 الطريقة الثانية: الربط عبر كلاود فلاير بروكسي (Cloudflare Proxy / Orange Cloud 🟠)

إذا كنت تستضيف خادم Node.js على استضافة مثل **Render**, **Railway**, **DigitalOcean**, **Hetzner** أو **VPS**:

1. **إعدادات السجل في Cloudflare (DNS Settings)**:
   - قم بإنشاء سجل `A` أو `CNAME` يشير إلى IP أو رابط استضافتك.
   - تأكد من تفعيل السحابة البرتقالية **Proxied 🟠**.

2. **تفعيل الـ WebSockets في كلاود فلاير**:
   - من لوحة Cloudflare -> اختر موقعك -> **Network**.
   - قم بتفعيل خيار **WebSockets** (مفعل افتراضياً).

3. **إعدادات التشفير (SSL/TLS Encryption)**:
   - اضغط على **SSL/TLS** في كلاود فلاير.
   - اختر الوضع **Full (Strict)** لضمان الاتصال المشفر والآمن بين كلاود فلاير وخادمك.

---

### 📦 الطريقة الثالثة: التشغيل المباشر عبر Docker

```bash
# 1. بناء صورة الدوكر
docker build -t omegooo-app .

# 2. تشغيل الحاوية
docker run -d -p 3000:3000 \
  -e ADMIN_USERNAME="admin" \
  -e ADMIN_PASSWORD="your_password" \
  -e PLISIO_API_KEY="cSqDM1bVZd6ElQ3pLQCq2vPJsHEbKazEO2wjE2IaZzQtyiL8IduUeAM2s9c_s6fa" \
  --name omegooo_container omegooo-app
```

---

## 🔑 متغيرات البيئة المهمة (Environment Variables)

| المتغير | الوصف | القيمة الافتراضية / العينة |
|---|---|---|
| `PORT` | منفذ تشغيل الخادم | `3000` |
| `ADMIN_USERNAME` | اسم مستخدم لوحة تحكم الأدمن | `admin` |
| `ADMIN_PASSWORD` | كلمة مرور لوحة تحكم الأدمن | `admin123` |
| `PLISIO_API_KEY` | مفتاح دفع بوابة Plisio.net | `cSqDM1bVZd6ElQ3pLQCq2vPJsHEbKazEO2wjE2IaZzQtyiL8IduUeAM2s9c_s6fa` |
| `GEMINI_API_KEY` | مفتاح الذكاء الاصطناعي (اختياري) | `your_gemini_key` |
| `SUPABASE_URL` | رابط قاعدة بيانات Supabase (اختياري) | `https://your-project.supabase.co` |
| `SUPABASE_KEY` | مفتاح Supabase (اختياري) | `your_supabase_key` |

---

## 🛠️ المميزات المضافة لملائمة Cloudflare:
- ✅ **CF-Connecting-IP Support**: جلب IP الزائرين الحقيقي بدقة لضمان حماية النظام وتقييد المعدلات.
- ✅ **WebSocket Compatibility**: توافق كامل مع Socket.io لتفادي انقطاع الدردشة المباشرة.
- ✅ **Cloudflare Dockerfile & docker-compose.yml**: جهاز للتشغيل الفوري.
- ✅ **_headers & _redirects**: ملفات تحسين التخزين المؤقت وحماية الترويسات على شبكة كلاود فلاير.
- ✅ **Health Check Endpoint (`/health`)**: فحص جاهزية الخادم التلقائي عبر مراقب كلاود فلاير.

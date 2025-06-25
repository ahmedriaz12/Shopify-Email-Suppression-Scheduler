# Shopify Email Suppression Scheduler

This Node.js application automatically suppresses and restores Shopify customer emails based on subscription tags. It also manages billing-date-based tagging via scheduled jobs and a webhook.

---

## 📦 Features

- 🕐 **Cron Jobs**
  - Suppresses customer emails with tag `daily subscription` every night.
  - Restores emails the next day.
  - Tags customers with `subscription due today` based on billing date.
  - Removes outdated tags.

- 💬 **Webhook**
  - `/webhook/billing-date` endpoint to receive billing info and store it for processing.

- 💾 **Logs**
  - Creates daily logs in a `/logs` directory.
  - Automatically deletes logs older than 30 days.

---

## 🛠 Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/shopify-email-scheduler.git
cd shopify-email-scheduler
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Create `.env` File

```env
SHOPIFY_API_TOKEN=your_shopify_token
SHOPIFY_SHOP=yourshop.myshopify.com
SHOPIFY_API_VERSION=2023-10
PORT=3001
```

### 4. Run the App

```bash
npm start
```

---

## 🔁 CRON Schedule

| Task                      | Time (Asia/Karachi) | Description                          |
|---------------------------|---------------------|--------------------------------------|
| Suppress Emails           | 01:17 AM            | Masks emails for tagged customers    |
| Restore Emails            | 01:35 AM            | Restores original emails             |
| Tag Customers as Due      | 09:05 PM            | Adds `subscription due today` tag    |
| Remove Outdated Tags      | 09:06 PM            | Removes outdated `due today` tags    |

---

## 📡 Webhook Endpoint

**POST** `/webhook/billing-date`

**Payload Example**:

```json
{
  "partner::next_billing_date": "2025-06-30",
  "partner::customer_email": "user@example.com",
  "shopify::customer_id": "gid://shopify/Customer/1234567890"
}
```

---

## 🧩 Dependencies

- express
- node-cron
- axios
- dotenv
- moment-timezone

---

## 📁 Logs

Logs are saved in the `logs/` folder and named by date. Example:

```
logs/
├── 2025-06-25.log
├── suppressedCustomersEmails.json
├── billing_dates.json
```

Old logs are purged automatically after 30 days.

---

## 👋 Author

Developed by [Muhammad Ahmed](https://github.com/ahmedriaz12)


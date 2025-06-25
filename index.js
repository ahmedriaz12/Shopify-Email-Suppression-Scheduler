import express from 'express';
import cron from 'node-cron';
import axios from 'axios';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import fs from 'fs/promises';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';

const LOG_DIR = path.join(process.cwd(), 'logs');
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR);
}

dotenv.config();

const requiredEnvVars = [
  'SHOPIFY_API_TOKEN',
  'SHOPIFY_SHOP',
  'SHOPIFY_API_VERSION'
];

for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    console.error(`Missing required environment variable: ${varName}`);
    process.exit(1); // Stop the app
  }
}


const app = express();
const port = process.env.PORT || 3001;
app.use(express.json()); 


(async () => {
  const files = await fs.readdir(LOG_DIR);
  const threshold = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const file of files) {
    const filePath = path.join(LOG_DIR, file);
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs < threshold) {
      try {
        await fs.unlink(filePath);
        console.log(`Deleted old log: ${file}`);
      } catch (err) {
        console.error(`Failed to delete log ${file}:`, err.message);
}
    }
  }
})();


const headers = {
  'X-Shopify-Access-Token': process.env.SHOPIFY_API_TOKEN,
  'Content-Type': 'application/json',
};


const STORAGE_FILE = path.join(LOG_DIR, 'suppressedCustomersEmails.json');


// Utility: Delay for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Utility: Retry wrapper
async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Retry ${i + 1} after error: ${err.message}`);
      await sleep(delay);
    }
  }
}

// Fetch customers with a specific tag
async function getTaggedCustomers(tag) {
  const results = [];
  let url = `https://${process.env.SHOPIFY_SHOP}/admin/api/${process.env.SHOPIFY_API_VERSION}/customers.json?limit=250&fields=id,email,tags`;

  while (url) {
    try {
      const res = await axios.get(url, { headers });
      const customers = res.data.customers || [];

      customers.forEach((cust) => {
        const tags = cust.tags.toLowerCase().split(',').map(t => t.trim());
        if (tags.includes(tag.toLowerCase())) {
          results.push({ id: cust.id, email: cust.email });
        }
      });

      const linkHeader = res.headers['link'];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        url = match ? match[1] : null;
      } else {
        url = null;
      }
    } catch (err) {
      console.error('Failed to fetch customers:', err.message);
      break;
    }
  }

  return results;
}

const logLine = async (line) => {
  const fileName = moment().format('YYYY-MM-DD') + '.log';
  const logPath = path.join(LOG_DIR, fileName);
  const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
  await fs.appendFile(logPath, `[${timestamp}] ${line}\n`);
};

let isSuppressing = false;


// Suppress emails
async function suppressEmails() {
    if (isSuppressing) {
    console.warn('Suppression already in progress, skipping duplicate run.');
    return;
  }
  const customers = await getTaggedCustomers('daily subscription');
  const suppressedEmails = [];
  isSuppressing = true;

  for (const customer of customers) {
    const isAlreadySuppressed = /^suppressed-\d+-\d+@noemail\.fake$/.test(customer.email);
    if (isAlreadySuppressed) {
      console.log(`⚠️ Skipping customer ${customer.id} — already suppressed`);
      await logLine(`Skipped suppression for customer ${customer.id}, already suppressed`);
      continue;
    }
  
    try {
      const fakeEmail = `suppressed-${Date.now()}-${customer.id}@noemail.fake`;

      await withRetry(() =>
        axios.put(
          `https://${process.env.SHOPIFY_SHOP}/admin/api/${process.env.SHOPIFY_API_VERSION}/customers/${customer.id}.json`,
          { customer: { id: customer.id, email: fakeEmail } },
          { headers }
        )
      );

      suppressedEmails.push({ id: customer.id, originalEmail: customer.email });
      console.log(`Suppressed email for customer ${customer.id}`);
      await logLine(`Suppressed email for customer ${customer.id}, original: ${customer.email}, order: N/A`);
    } catch (err) {
      console.error(`Failed to suppress email for ${customer.id}:`, err.message);
      await logLine(`ERROR suppressing email for customer ${customer.id}: ${err.message}`);
    }

    await sleep(300);
  }

  try {
    await fs.writeFile(STORAGE_FILE, JSON.stringify(suppressedEmails, null, 2));
    console.log('Suppressed emails saved to file');
  } catch (err) {
    console.error('Failed to save suppressed emails:', err.message);
  }
  finally {
      isSuppressing = false;
    }
}


// Restore emails
async function restoreEmails() {
  const maxWait = 3 * 60 * 1000;
  const start = Date.now();
  let successCount = 0;
  let failureCount = 0;

  let suppressedEmails = [];

   while (isSuppressing && (Date.now() - start < maxWait)) {
    console.log('Waiting for suppression to finish before restoring...');
    await sleep(500); // check every half second
  }

  if (isSuppressing) {
    console.warn('Suppression did not complete in time. Skipping restore to avoid conflict.');
    await logLine('Restore skipped due to ongoing suppression.');
    return;
  }

  try {
    const data = await fs.readFile(STORAGE_FILE, 'utf-8');
    try {
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) throw new Error('Suppressed email data is not an array');
      suppressedEmails = parsed;
    } catch (parseErr) {
      console.error('Failed to parse suppressed email JSON:', parseErr.message);
      await logLine(`ERROR parsing suppressedEmails file: ${parseErr.message}`);
      return;
    }
  } catch (readErr) {
    console.log('No suppressed emails to restore');
    return;
  }

  for (const customer of suppressedEmails) {
    try {
      await withRetry(() =>
        axios.put(
          `https://${process.env.SHOPIFY_SHOP}/admin/api/${process.env.SHOPIFY_API_VERSION}/customers/${customer.id}.json`,
          { customer: { id: customer.id, email: customer.originalEmail } },
          { headers }
        )
      );

      successCount++;
      console.log(`Restored email for customer ${customer.id}`);
      await logLine(`Restored email for customer ${customer.id}, email: ${customer.originalEmail}, order: N/A`);
    } catch (err) {
      failureCount++;
      console.error(`Failed to restore email for ${customer.id}:`, err.message);
      await logLine(`ERROR restoring email for customer ${customer.id}: ${err.message}`);
    }

    await sleep(300);
  }

  try {
    await fs.unlink(STORAGE_FILE);
    console.log('Removed suppressed email file after restore');
  } catch (err) {
    console.error('Failed to delete suppression file:', err.message);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  const summary = `🔁 Restore Summary: ${successCount} restored, ${failureCount} failed, time taken: ${duration}s`;
  console.log(summary);
  await logLine(summary);
}



// Cron: Suppress at 11:58 PM 
cron.schedule('17 1 * * *', async () => {
  try {
    console.log(`Suppression job triggered at ${moment().tz("Asia/Karachi").format("hh:mm A z")}`);
    await suppressEmails();
  } catch (err) {
    console.error('Unhandled error in suppression cron:', err.message);
    await logLine(`FATAL ERROR in suppression cron: ${err.message}`);
  }
}, { timezone: "Asia/Karachi" });

cron.schedule('35 1 * * *', async () => {
  try {
    console.log(`Restore job triggered at ${moment().tz("Asia/Karachi").format("hh:mm A z")}`);
    await restoreEmails();
  } catch (err) {
    console.error('Unhandled error in restore cron:', err.message);
    await logLine(`FATAL ERROR in restore cron: ${err.message}`);
  }
}, { timezone: "Asia/Karachi" });


// On startup: Fallback restore if file exists
(async () => {
  try {
    await fs.access(STORAGE_FILE);
    console.warn('Suppressed email file detected on startup. Attempting fallback restore...');
    await restoreEmails();
  } catch {
    // File does not exist — nothing to do
  }
})();




app.post('/webhook/billing-date', async (req, res) => {
  try {
    console.log('Incoming body:', req.body);

    const { 'partner::next_billing_date': rawDate, 'partner::customer_email': email, 'shopify::customer_id': gid } = req.body;
    const customerId = gid.split('/').pop();
    const nextBillingDate = moment(rawDate).tz('Asia/Karachi').format('YYYY-MM-DD');

    const filePath = path.join(LOG_DIR, 'billing_dates.json');
    let data = {};

    try {
      const file = await fs.readFile(filePath, 'utf-8');
      data = JSON.parse(file);
    } catch (_) {}

    data[customerId] = { next_billing_date: nextBillingDate, email };

    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    await logLine(`Saved billing date for ${customerId}: ${nextBillingDate}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(500);
  }
});



cron.schedule('5 21 * * *', async () => {
  const today = moment().tz("Asia/Karachi").format('YYYY-MM-DD');
  const filePath = path.join(LOG_DIR, 'billing_dates.json');

  try {
    const file = await fs.readFile(filePath, 'utf-8');
    const billingData = JSON.parse(file);

    for (const customerId in billingData) {
      const entry = billingData[customerId];
      if (entry.next_billing_date === today) {
        try {
          // Fetch existing tags
          const res = await axios.get(
            `https://${process.env.SHOPIFY_SHOP}/admin/api/${process.env.SHOPIFY_API_VERSION}/customers/${customerId}.json`,
            { headers }
          );

          const existingTags = res.data.customer.tags || '';
          const tagList = existingTags.split(',').map(t => t.trim());
          if (!tagList.includes('subscription due today')) {
            tagList.push('subscription due today');
          }

          // Update with appended tag
          await axios.put(
            `https://${process.env.SHOPIFY_SHOP}/admin/api/${process.env.SHOPIFY_API_VERSION}/customers/${customerId}.json`,
            {
              customer: {
                id: customerId,
                tags: tagList.join(', ')
              }
            },
            { headers }
          );

          await logLine(`Tagged customer ${customerId} as "subscription due today"`);
        } catch (err) {
          await logLine(`ERROR tagging ${customerId}: ${err.message}`);
        }

        await sleep(500);
      }
    }
  } catch (err) {
    console.error('Billing tag cron error:', err.message);
    await logLine(`FATAL ERROR in tag cron: ${err.message}`);
  }
}, { timezone: "Asia/Karachi" });




cron.schedule('6 21 * * *', async () => {
  const today = moment().tz("Asia/Karachi").format('YYYY-MM-DD');
  const filePath = path.join(LOG_DIR, 'billing_dates.json');

  let billingData = {};
  try {
    const file = await fs.readFile(filePath, 'utf-8');
    billingData = JSON.parse(file);
  } catch (err) {
    await logLine(`ERROR reading billing_dates.json: ${err.message}`);
    return;
  }

  try {
    const customers = await getTaggedCustomers('subscription due today');

    for (const customer of customers) {
      const entry = billingData[customer.id];
      if (entry?.next_billing_date === today) {
        await logLine(`Skipped removing tag for ${customer.id}, billing is today`);
        continue;
      }

      try {
        const res = await axios.get(
          `https://${process.env.SHOPIFY_SHOP}/admin/api/${process.env.SHOPIFY_API_VERSION}/customers/${customer.id}.json`,
          { headers }
        );

        const existingTags = res.data.customer.tags || '';
        const updatedTags = existingTags
          .split(',')
          .map(t => t.trim())
          .filter(t => t.toLowerCase() !== 'subscription due today');

        await axios.put(
          `https://${process.env.SHOPIFY_SHOP}/admin/api/${process.env.SHOPIFY_API_VERSION}/customers/${customer.id}.json`,
          {
            customer: {
              id: customer.id,
              tags: updatedTags.join(', ')
            }
          },
          { headers }
        );

        await logLine(`Removed "subscription due today" tag from ${customer.id}`);
      } catch (innerErr) {
        await logLine(`ERROR removing tag for ${customer.id}: ${innerErr.message}`);
      }

      await sleep(500);
    }
  } catch (err) {
    await logLine(`FATAL ERROR removing tags: ${err.message}`);
  }
}, { timezone: "Asia/Karachi" });







const server = app.listen(port, () => {
  console.log(`Email suppression scheduler running on port ${port}`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('\nGraceful shutdown initiated...');
  try {
    // Cancel any scheduled tasks (cron doesn't have direct stop API, but no cleanup needed)
    // Restore any suppressed emails if still pending
    await restoreEmails();

    // We can clean database if we use in future
    console.log('Clean-up complete. Shutting down server...');
    server.close(() => {
      process.exit(0);
    });
  } catch (err) {
    console.error('Error during shutdown:', err.message);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);   // Ctrl+C
process.on('SIGTERM', shutdown);  // kill command / container stop


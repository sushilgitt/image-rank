// Mandatory privacy (GDPR) compliance webhooks:
//   customers/data_request, customers/redact, shop/redact
//
// authenticate.webhook verifies the HMAC and throws a 401 Response on an
// invalid signature, which Shopify's compliance checks require.
//
// Image Rank stores no customer personal data — only per-shop sessions, the
// monthly usage counter and app settings — so the two customer topics have
// nothing to export or erase. shop/redact (sent 48h after uninstall) erases
// everything stored for the shop.
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // No customer data is stored by this app.
      break;
    case "SHOP_REDACT":
      await db.$transaction([
        db.session.deleteMany({ where: { shop } }),
        db.usageCounter.deleteMany({ where: { shop } }),
        db.shopSettings.deleteMany({ where: { shop } }),
      ]);
      break;
    default:
      break;
  }

  return new Response();
};

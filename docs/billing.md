# Stripe billing

Kosmitor supports company subscriptions and one-time payments for 409A requests
through Stripe-hosted Checkout. The customer portal lets a company manage its
subscription and billing details. Card details are entered on Stripe's pages.

For new 409A requests made with billing enabled, the order is:

**Request → payment confirmed → internal approval → evaluator.**

A paid valuation still needs internal approval. A subscription and a valuation
payment are separate purchases. Existing requests keep their earlier workflow.
Workspace access continues to follow existing membership roles; subscription
plans control billing without introducing feature entitlements.
Returning from Checkout is not proof of payment; the server confirms payment
before the request can proceed.

New checkouts are disabled in the shipped configuration. Production activation requires
your Stripe account, credentials, Price IDs, portal configuration and webhook.
The application does not create products or choose prices for you.

## Configure products and credentials

Create recurring Stripe Prices for the subscription plans you want to offer and
a separate one-time Price for a 409A request. Use Price IDs, starting with
`price_`, from the same Stripe account and test or live mode as the API key.
Amounts, currencies and recurring intervals are fetched from Stripe; no amount
is accepted from the browser or hardcoded in the application configuration.

The non-secret settings belong in your ignored `kosmitor.config.local.json`:

```json
{
  "billing": {
    "enabled": true,
    "subscriptionPlans": [
      { "key": "standard", "name": "Standard", "priceId": "price_REPLACEWITHRECURRING" }
    ],
    "valuationPriceId": "price_REPLACEWITHONETIME"
  }
}
```

Plan keys and all configured Price IDs must be distinct. Up to 10 subscription
plans are supported. Keep each key stable when changing its display name or
price. An empty plan list leaves subscription purchases unconfigured. A null
valuation Price ID leaves valuation purchases unconfigured and blocks new 409A
requests while billing is enabled; it does not bypass payment.

The following environment variables override those settings:

| Variable | Value |
| --- | --- |
| `BILLING_ENABLED` | `true` or `false` |
| `STRIPE_SUBSCRIPTION_PLANS` | A JSON array of objects with `key`, `name` and `priceId`; `[]` clears the list |
| `STRIPE_VALUATION_PRICE_ID` | The one-time Price ID; an empty value leaves the file setting in effect |

Store `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` only in the ignored
`apps/server/.env` for local development, or the deployment's secret store.
Neither belongs in a configuration JSON file, client code or a checked-in
Terraform variables file. The public page configuration includes only whether
billing is enabled. Missing credentials leave payment operations unavailable.
Turning billing off stops new checkouts; retain the credentials so existing
customers can use the portal and Stripe can reconcile payments through webhooks.

In Stripe, configure the customer portal features you want companies to use,
such as billing-detail updates, payment methods, invoices and subscription
cancellation. Portal availability and supported plan changes depend on that
configuration. See [Stripe's customer portal guide](https://docs.stripe.com/customer-management).

## Register the webhook

Create an HTTPS webhook endpoint for your deployed app:

```text
https://<your-app-host>/api/stripe/webhook
```

Subscribe it to these events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `charge.refunded`

Choose the **snapshot** event format and API version `2026-09-30.endive`,
matching the installed Stripe SDK (`stripe` 23.0.0). The webhook handler reads
snapshot objects, including the invoice subscription details from that API
version. Review the endpoint version alongside any future SDK upgrade.

Use that endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`. Local Stripe CLI
forwarding has its own signing secret; do not substitute it for the deployed
endpoint's secret. Verification uses the original request bytes and the
`Stripe-Signature` header. See [Stripe's webhook setup and verification guide](https://docs.stripe.com/webhooks).

Keep the webhook reachable without an application session. A browser redirect
can be missed, and some payment methods complete later, so payment confirmation
must not depend on the customer returning to the app. See [Stripe's Checkout
fulfillment guide](https://docs.stripe.com/checkout/fulfillment).

## Deploy with Terraform

In your ignored `infra/azure/terraform.tfvars`, configure the non-secret values:

```hcl
billing_enabled = true
stripe_subscription_plans = [
  { key = "standard", name = "Standard", priceId = "price_REPLACEWITHRECURRING" }
]
stripe_valuation_price_id = "price_REPLACEWITHONETIME"
```

Supply the two credentials through `TF_VAR_stripe_secret_key` and
`TF_VAR_stripe_webhook_secret` in the environment running Terraform. A plan with
billing enabled refuses missing credentials. Terraform stores the credentials
in Azure Key Vault and passes secret references to the app; backup and restore
jobs do not receive Stripe credentials. Keep Terraform state and saved plans
private because they contain secret values.

The secret resources and app references remain present whenever their credential
inputs are supplied, including when `billing_enabled` is false. Keep supplying
both inputs while any payment or subscription still needs webhook updates.

Deploy an application image containing the billing integration before enabling
it. Terraform defaults billing to off and the subscription catalog to an empty
list. A Terraform change to the configured plans or Price ID creates a new app
revision without rebuilding the image. Prices and credentials must be supplied
before production payments can be activated.

## Verify before enabling live payments

Use Stripe test mode in a separate local or staging database first. Confirm that a company can start Checkout, that a
cancelled or unpaid Checkout leaves a valuation waiting for payment, and that
confirmed payment unlocks internal review rather than notifying the evaluator
directly. Complete internal approval and check that evaluator delivery follows.
Also test a subscription purchase and its customer portal session.

Check webhook delivery results in Stripe, including repeated deliveries and a
delayed payment. A test payment must never update a live-mode purchase. Configure
production with its live API key, live Prices and live webhook signing secret
before its first purchase. Keep each database bound to one Stripe account and
mode: do not switch an existing billing database between test and live mode or
between Stripe accounts, since its saved customer and payment IDs belong to
the original account and mode. Refunds are initiated in Stripe; this integration listens for refund
updates and does not automatically refund a cancelled valuation request.

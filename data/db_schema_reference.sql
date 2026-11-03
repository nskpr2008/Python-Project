-- VoltBay 4.0 schema (PostgreSQL 13+). Money is stored in paise (integer) to avoid rounding errors.
-- The server must compute prices, totals and stock changes. Never trust client-submitted values.
BEGIN;

CREATE TYPE order_status   AS ENUM ('pending','paid','packed','shipped','delivered','cancelled','returned');
CREATE TYPE payment_status AS ENUM ('created','authorized','captured','failed','refunded');
CREATE TYPE ticket_status  AS ENUM ('open','in_progress','waiting_customer','resolved','closed');
CREATE TYPE repair_status  AS ENUM ('request_received','inspection_pending','under_diagnosis','estimate_provided','repair_approved','repair_in_progress','ready_for_collection','completed','cancelled');
CREATE TYPE risk_level     AS ENUM ('low','medium','high','critical');

-- Identity and access
CREATE TABLE roles (id serial PRIMARY KEY, name text UNIQUE NOT NULL);
CREATE TABLE permissions (id serial PRIMARY KEY, code text UNIQUE NOT NULL);
CREATE TABLE role_permissions (role_id int REFERENCES roles ON DELETE CASCADE, permission_id int REFERENCES permissions ON DELETE CASCADE, PRIMARY KEY (role_id, permission_id));
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL, password_hash text,           -- null when an external auth provider is used
  full_name text, phone text, role_id int REFERENCES roles,
  email_verified_at timestamptz, mfa_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));
CREATE TABLE addresses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  label text, line1 text NOT NULL, line2 text, city text NOT NULL, state text NOT NULL, pincode text NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'), is_default boolean NOT NULL DEFAULT false);

-- Catalogue: departments and subcategories share one self-referencing table
CREATE TABLE brands (id serial PRIMARY KEY, name text UNIQUE NOT NULL);
CREATE TABLE categories (id serial PRIMARY KEY, parent_id int REFERENCES categories, name text NOT NULL, slug text UNIQUE NOT NULL, sort int NOT NULL DEFAULT 0);
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id int REFERENCES brands, category_id int NOT NULL REFERENCES categories,
  name text NOT NULL, model_number text, description text, warranty_months int CHECK (warranty_months >= 0),
  is_refurbished boolean NOT NULL DEFAULT false, condition_grade text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','published','archived')),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX products_category ON products (category_id);
CREATE INDEX products_brand ON products (brand_id);
CREATE INDEX products_search ON products USING gin (to_tsvector('simple', name || ' ' || coalesce(model_number,'')));
CREATE TABLE product_specs (product_id uuid REFERENCES products ON DELETE CASCADE, key text, value text NOT NULL, PRIMARY KEY (product_id, key));
CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products ON DELETE CASCADE,
  sku text UNIQUE NOT NULL, attributes jsonb NOT NULL DEFAULT '{}',   -- e.g. {"ram":"8 GB","storage":"256 GB","colour":"Black"}
  price_paise bigint NOT NULL CHECK (price_paise >= 0), mrp_paise bigint CHECK (mrp_paise >= 0), cost_paise bigint CHECK (cost_paise >= 0),
  active boolean NOT NULL DEFAULT true);
CREATE INDEX variants_product ON product_variants (product_id);
CREATE TABLE product_images (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products ON DELETE CASCADE, variant_id uuid REFERENCES product_variants, url text NOT NULL, alt text, sort int NOT NULL DEFAULT 0);
CREATE TABLE compatibility (variant_id uuid REFERENCES product_variants ON DELETE CASCADE, accessory_variant_id uuid REFERENCES product_variants ON DELETE CASCADE, source text NOT NULL, PRIMARY KEY (variant_id, accessory_variant_id)); -- only verified pairs are stored

-- Inventory and suppliers
CREATE TABLE inventory (variant_id uuid PRIMARY KEY REFERENCES product_variants ON DELETE CASCADE, quantity_on_hand int NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0), reorder_level int NOT NULL DEFAULT 5 CHECK (reorder_level >= 0));
CREATE TABLE stock_movements (id bigserial PRIMARY KEY, variant_id uuid NOT NULL REFERENCES product_variants, delta int NOT NULL, reason text NOT NULL, ref_type text, ref_id text, created_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE suppliers (id serial PRIMARY KEY, name text NOT NULL, contact_name text, email text, phone text);
CREATE TABLE purchase_orders (id serial PRIMARY KEY, supplier_id int NOT NULL REFERENCES suppliers, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','received','cancelled')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE purchase_order_items (po_id int REFERENCES purchase_orders ON DELETE CASCADE, variant_id uuid REFERENCES product_variants, qty int NOT NULL CHECK (qty > 0), unit_cost_paise bigint NOT NULL CHECK (unit_cost_paise >= 0), PRIMARY KEY (po_id, variant_id));

-- Shopping
CREATE TABLE carts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users ON DELETE CASCADE, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE cart_items (cart_id uuid REFERENCES carts ON DELETE CASCADE, variant_id uuid REFERENCES product_variants, qty int NOT NULL CHECK (qty > 0), PRIMARY KEY (cart_id, variant_id));
CREATE TABLE wishlists (user_id uuid REFERENCES users ON DELETE CASCADE, variant_id uuid REFERENCES product_variants ON DELETE CASCADE, PRIMARY KEY (user_id, variant_id));
CREATE TABLE coupons (code text PRIMARY KEY, percent_off int CHECK (percent_off BETWEEN 1 AND 90), flat_off_paise bigint CHECK (flat_off_paise > 0), starts_at timestamptz, ends_at timestamptz, max_uses int, uses int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
  CHECK (percent_off IS NOT NULL OR flat_off_paise IS NOT NULL));
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_no text UNIQUE NOT NULL, user_id uuid REFERENCES users,
  status order_status NOT NULL DEFAULT 'pending', ship_to jsonb NOT NULL,
  subtotal_paise bigint NOT NULL, discount_paise bigint NOT NULL DEFAULT 0, shipping_paise bigint NOT NULL DEFAULT 0, total_paise bigint NOT NULL,
  coupon_code text REFERENCES coupons, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total_paise = subtotal_paise - discount_paise + shipping_paise));
CREATE INDEX orders_user ON orders (user_id, created_at DESC);
CREATE TABLE order_items (order_id uuid REFERENCES orders ON DELETE CASCADE, variant_id uuid REFERENCES product_variants, sku text NOT NULL, name text NOT NULL, unit_price_paise bigint NOT NULL, qty int NOT NULL CHECK (qty > 0), PRIMARY KEY (order_id, variant_id));
-- No card numbers, CVVs or bank credentials are ever stored. Only gateway reference ids.
CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders, provider text NOT NULL, provider_order_id text, provider_payment_id text UNIQUE, status payment_status NOT NULL DEFAULT 'created', amount_paise bigint NOT NULL, verified_at timestamptz);
CREATE TABLE refunds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL REFERENCES payments, amount_paise bigint NOT NULL CHECK (amount_paise > 0), reason text, approved_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()); -- refunds need a named human approver
CREATE TABLE shipments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders, carrier text, tracking_no text, status text, updated_at timestamptz NOT NULL DEFAULT now());

-- Reviews, service and notifications
CREATE TABLE reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products, user_id uuid NOT NULL REFERENCES users, order_id uuid, rating int NOT NULL CHECK (rating BETWEEN 1 AND 5), body text, verified_purchase boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE support_tickets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users, subject text NOT NULL, body text NOT NULL, category text, priority text, status ticket_status NOT NULL DEFAULT 'open', assigned_to uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE repair_bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ref text UNIQUE NOT NULL, user_id uuid REFERENCES users, device_type text NOT NULL, brand text NOT NULL, model text NOT NULL, problem text NOT NULL, preferred_date date, pickup boolean NOT NULL DEFAULT false, status repair_status NOT NULL DEFAULT 'request_received', estimate_paise bigint CHECK (estimate_paise >= 0), notes text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, kind text NOT NULL, body text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE price_alerts (user_id uuid REFERENCES users ON DELETE CASCADE, variant_id uuid REFERENCES product_variants ON DELETE CASCADE, target_paise bigint NOT NULL CHECK (target_paise > 0), PRIMARY KEY (user_id, variant_id));

-- Real price history: every price change is recorded automatically, so nothing needs to be invented
CREATE TABLE price_history (id bigserial PRIMARY KEY, variant_id uuid NOT NULL REFERENCES product_variants ON DELETE CASCADE, price_paise bigint NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX price_history_variant ON price_history (variant_id, recorded_at DESC);
CREATE FUNCTION log_price_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.price_paise IS DISTINCT FROM OLD.price_paise THEN
    INSERT INTO price_history (variant_id, price_paise) VALUES (NEW.id, NEW.price_paise);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER variants_price_history AFTER INSERT OR UPDATE OF price_paise ON product_variants FOR EACH ROW EXECUTE FUNCTION log_price_change();

-- AI usage and security
CREATE TABLE ai_conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users ON DELETE CASCADE, mode text NOT NULL CHECK (mode IN ('demo','live')), scope text NOT NULL CHECK (scope IN ('customer','admin')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ai_usage_logs (id bigserial PRIMARY KEY, user_id uuid REFERENCES users, feature text NOT NULL, mode text NOT NULL, tokens_in int, tokens_out int, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE security_events (id bigserial PRIMARY KEY, user_id uuid REFERENCES users, kind text NOT NULL, risk risk_level NOT NULL, details jsonb NOT NULL DEFAULT '{}', ip inet, reviewed_by uuid REFERENCES users, resolution text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX security_events_risk ON security_events (risk, created_at DESC);
CREATE TABLE audit_logs (id bigserial PRIMARY KEY, actor_id uuid REFERENCES users, action text NOT NULL, entity text NOT NULL, entity_id text, diff jsonb, created_at timestamptz NOT NULL DEFAULT now());
-- Make the audit log append-only for the application role (adjust the role name):
--   REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM voltbay_app;
COMMIT;

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Tier = "Basic" | "Pro";

const PRODUCT_MAP: Record<Tier, { name: string; amount: number }> = {
  Basic: {
    name: "Nextflow Pro Basic - 30 Hari",
    amount: 255000,
  },
  Pro: {
    name: "Nextflow Pro Pro - 30 Hari",
    amount: 305000,
  },
};

function getMidtransSnapUrl() {
  const isProduction = Deno.env.get("MIDTRANS_IS_PRODUCTION") === "true";
  return isProduction
    ? "https://app.midtrans.com/snap/v1/transactions"
    : "https://app.sandbox.midtrans.com/snap/v1/transactions";
}

function makeOrderId(tier: string) {
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  return `NFP-${tier.toUpperCase()}-${Date.now()}-${random}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ success: false, message: "Method not allowed" }),
        { status: 405, headers: corsHeaders },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const midtransServerKey = Deno.env.get("MIDTRANS_SERVER_KEY")!;
    const siteUrl = Deno.env.get("SITE_URL")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, message: "Unauthorized" }),
        { status: 401, headers: corsHeaders },
      );
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ success: false, message: "User tidak valid" }),
        { status: 401, headers: corsHeaders },
      );
    }

    const body = await req.json();
    const tier = body.tier as Tier;

    if (!["Basic", "Pro"].includes(tier)) {
      return new Response(
        JSON.stringify({ success: false, message: "Paket tidak valid" }),
        { status: 400, headers: corsHeaders },
      );
    }

    const product = PRODUCT_MAP[tier];
    const orderId = makeOrderId(tier);
    const email = user.email ?? "";

    if (!email) {
      return new Response(
        JSON.stringify({ success: false, message: "Email user tidak ditemukan" }),
        { status: 400, headers: corsHeaders },
      );
    }

    const invoiceNumber = `INV-${new Date().getFullYear()}-${orderId}`;

    const payload = {
      transaction_details: {
        order_id: orderId,
        gross_amount: product.amount,
      },
      customer_details: {
        email,
        first_name:
          user.user_metadata?.full_name ||
          user.user_metadata?.name ||
          email.split("@")[0],
      },
      item_details: [
        {
          id: `NEXTFLOW-${tier.toUpperCase()}`,
          price: product.amount,
          quantity: 1,
          name: product.name,
        },
      ],
      callbacks: {
        finish: `${siteUrl}/payment/success?order_id=${orderId}`,
        error: `${siteUrl}/payment/error?order_id=${orderId}`,
        pending: `${siteUrl}/payment/pending?order_id=${orderId}`,
      },
      expiry: {
        unit: "hours",
        duration: 24,
      },
      custom_field1: user.id,
      custom_field2: tier,
      custom_field3: invoiceNumber,
    };

    const authString = btoa(`${midtransServerKey}:`);

    const midtransRes = await fetch(getMidtransSnapUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${authString}`,
      },
      body: JSON.stringify(payload),
    });

    const midtransData = await midtransRes.json();

    if (!midtransRes.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Gagal membuat transaksi Midtrans",
          detail: midtransData,
        }),
        { status: 500, headers: corsHeaders },
      );
    }

    const { error: insertError } = await adminClient
      .from("payment_transactions")
      .insert({
        order_id: orderId,
        user_id: user.id,
        email,
        tier,
        amount: product.amount,
        status: "pending",
        snap_token: midtransData.token,
        redirect_url: midtransData.redirect_url,
        invoice_number: invoiceNumber,
      });

    if (insertError) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Gagal menyimpan transaksi",
          detail: insertError.message,
        }),
        { status: 500, headers: corsHeaders },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        order_id: orderId,
        snap_token: midtransData.token,
        redirect_url: midtransData.redirect_url,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({
        success: false,
        message: String(e),
      }),
      { status: 500, headers: corsHeaders },
    );
  }
});

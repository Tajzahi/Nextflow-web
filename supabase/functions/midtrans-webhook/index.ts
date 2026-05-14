import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function sha512(input: string) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-512", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isPaymentSuccess(transactionStatus: string, fraudStatus?: string) {
  if (transactionStatus === "settlement") return true;
  if (transactionStatus === "capture") {
    return fraudStatus === "accept" || !fraudStatus;
  }
  return false;
}

function mapMidtransStatus(transactionStatus: string) {
  switch (transactionStatus) {
    case "settlement":
    case "capture":
      return "paid";
    case "pending":
      return "pending";
    case "expire":
      return "expired";
    case "cancel":
    case "deny":
      return "failed";
    case "refund":
    case "partial_refund":
      return "refunded";
    default:
      return "pending";
  }
}

async function sendLicenseEmail(params: {
  to: string;
  tier: string;
  licenseKey: string;
  invoiceNumber: string;
  amount: number;
}) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM") || "Nextflow Pro <noreply@example.com>";

  if (!apiKey) {
    console.warn("RESEND_API_KEY not set, skipping email.");
    return;
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: auto;">
      <h2>Terima kasih telah membeli Nextflow Pro</h2>
      <p>Pembayaran Anda telah berhasil diverifikasi.</p>

      <h3>Detail Lisensi</h3>
      <table cellpadding="8" cellspacing="0" border="1" style="border-collapse: collapse;">
        <tr>
          <td><strong>Paket</strong></td>
          <td>${params.tier}</td>
        </tr>
        <tr>
          <td><strong>Token Lisensi</strong></td>
          <td><code style="font-size: 16px;">${params.licenseKey}</code></td>
        </tr>
        <tr>
          <td><strong>Invoice</strong></td>
          <td>${params.invoiceNumber}</td>
        </tr>
        <tr>
          <td><strong>Total</strong></td>
          <td>Rp ${params.amount.toLocaleString("id-ID")}</td>
        </tr>
      </table>

      <p style="margin-top: 20px;">
        Cara aktivasi:
      </p>
      <ol>
        <li>Buka aplikasi Nextflow Pro.</li>
        <li>Masukkan token lisensi di atas.</li>
        <li>Token akan terkunci ke laptop pertama yang digunakan.</li>
      </ol>

      <p>
        Jika ada kendala, silakan hubungi admin/support.
      </p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: params.to,
      subject: `Token Lisensi Nextflow Pro - ${params.tier}`,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Email send failed:", text);
  }
}

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const midtransServerKey = Deno.env.get("MIDTRANS_SERVER_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const notif = await req.json();

    const orderId = notif.order_id;
    const statusCode = notif.status_code;
    const grossAmount = notif.gross_amount;
    const signatureKey = notif.signature_key;
    const transactionStatus = notif.transaction_status;
    const fraudStatus = notif.fraud_status;
    const transactionId = notif.transaction_id;
    const paymentType = notif.payment_type;

    if (!orderId || !statusCode || !grossAmount || !signatureKey) {
      return new Response(
        JSON.stringify({ success: false, message: "Invalid payload" }),
        { status: 400 },
      );
    }

    const expectedSignature = await sha512(
      `${orderId}${statusCode}${grossAmount}${midtransServerKey}`,
    );

    if (expectedSignature !== signatureKey) {
      return new Response(
        JSON.stringify({ success: false, message: "Invalid signature" }),
        { status: 403 },
      );
    }

    const { data: tx, error: txError } = await adminClient
      .from("payment_transactions")
      .select("*")
      .eq("order_id", orderId)
      .single();

    if (txError || !tx) {
      return new Response(
        JSON.stringify({ success: false, message: "Transaction not found" }),
        { status: 404 },
      );
    }

    const mappedStatus = mapMidtransStatus(transactionStatus);

    // Jika belum sukses, cukup update status
    if (!isPaymentSuccess(transactionStatus, fraudStatus)) {
      await adminClient
        .from("payment_transactions")
        .update({
          status: mappedStatus,
          midtrans_transaction_id: transactionId,
          payment_type: paymentType,
          fraud_status: fraudStatus,
          raw_notification: notif,
        })
        .eq("order_id", orderId);

      return new Response(
        JSON.stringify({ success: true, message: "Status updated", status: mappedStatus }),
        { status: 200 },
      );
    }

    // Idempotency: jika sudah pernah generate license, jangan generate ulang
    if (tx.status === "paid" && tx.license_key) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Already processed",
          license_key: tx.license_key,
        }),
        { status: 200 },
      );
    }

    // Generate license via RPC existing Anda
    const { data: licenseResult, error: licenseError } = await adminClient.rpc(
      "generate_license",
      {
        p_user_id: tx.user_id,
        p_tier: tx.tier,
      },
    );

    if (licenseError) {
      console.error("generate_license error:", licenseError);
      return new Response(
        JSON.stringify({
          success: false,
          message: "Failed to generate license",
          detail: licenseError.message,
        }),
        { status: 500 },
      );
    }

    if (!licenseResult?.success) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "generate_license returned failed",
          detail: licenseResult,
        }),
        { status: 500 },
      );
    }

    const licenseKey = licenseResult.license_key;

    await adminClient
      .from("payment_transactions")
      .update({
        status: "paid",
        midtrans_transaction_id: transactionId,
        payment_type: paymentType,
        fraud_status: fraudStatus,
        raw_notification: notif,
        license_key: licenseKey,
        license_generated_at: new Date().toISOString(),
      })
      .eq("order_id", orderId);

    await sendLicenseEmail({
      to: tx.email,
      tier: tx.tier,
      licenseKey,
      invoiceNumber: tx.invoice_number,
      amount: tx.amount,
    });

    await adminClient
      .from("payment_transactions")
      .update({
        invoice_sent_at: new Date().toISOString(),
      })
      .eq("order_id", orderId);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Payment processed and license generated",
        license_key: licenseKey,
      }),
      { status: 200 },
    );
  } catch (e) {
    console.error(e);
    return new Response(
      JSON.stringify({
        success: false,
        message: String(e),
      }),
      { status: 500 },
    );
  }
});

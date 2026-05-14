import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1. Cek User Login
    const authHeader = req.headers.get("Authorization");
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader || "" } },
    });
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ success: false, message: "Harap login terlebih dahulu" }), { status: 401, headers: corsHeaders });
    }

    // 2. Cek apakah sudah pernah klaim
    const { data: existingClaim } = await adminClient
      .from("free_trial_claims")
      .select("id, license_key")
      .eq("user_id", user.id)
      .single();

    if (existingClaim) {
      return new Response(JSON.stringify({ 
        success: false, 
        message: "Anda sudah pernah mengklaim Paket Free.",
        license_key: existingClaim.license_key 
      }), { status: 400, headers: corsHeaders });
    }

    // 3. Generate Lisensi 'Free'
    const { data: licenseResult, error: licenseError } = await adminClient.rpc(
      "generate_license",
      { p_user_id: user.id, p_tier: "Free" }
    );

    if (licenseError || !licenseResult?.success) {
      throw new Error(licenseError?.message || "Gagal membuat lisensi");
    }

    const licenseKey = licenseResult.license_key;

    // 4. Catat ke tabel free_trial_claims agar tidak bisa klaim dua kali
    await adminClient.from("free_trial_claims").insert({
      user_id: user.id,
      email: user.email,
      license_key: licenseKey
    });

    // 5. Kembalikan lisensi ke Frontend
    return new Response(JSON.stringify({ success: true, license_key: licenseKey }), {
      status: 200, headers: corsHeaders,
    });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, message: String(e) }), {
      status: 500, headers: corsHeaders,
    });
  }
});

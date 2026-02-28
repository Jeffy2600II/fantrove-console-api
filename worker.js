// ============================================
// Cloudflare Worker - Fantrove Console API
// หน้าที่: รับ logs จาก browser → ส่งไป Supabase
// ไม่มีการลบ logs (ให้ Supabase pg_cron จัดการ)
// ============================================

// CORS headers สำหรับทุก response
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Routing
      switch (true) {
        case request.method === 'GET' && path === '/logs':
          return await handleGetLogs(request, env);
        
        case request.method === 'POST' && path === '/logs':
          return await handlePostLog(request, env);
        
        case request.method === 'POST' && path === '/logs/batch':
          return await handlePostBatch(request, env);
        
        case request.method === 'GET' && path === '/health':
          return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
        
        default:
          return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
      }
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({ error: error.message }, 500);
    }
  }
};

// ============================================
// Handler Functions
// ============================================

async function handleGetLogs(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, 500);
  const offset = parseInt(url.searchParams.get('offset')) || 0;

  let query = `${env.SUPABASE_URL}/rest/v1/console_logs?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
  
  if (sessionId) {
    query += `&session_id=eq.${encodeURIComponent(sessionId)}`;
  }

  const response = await fetch(query, {
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase error: ${response.status} ${await response.text()}`);
  }

  const logs = await response.json();
  return jsonResponse(logs);
}

async function handlePostLog(request, env) {
  const body = await request.json();
  
  // Validate required fields
  if (!body.level || !body.message) {
    return jsonResponse({ error: 'Missing required fields: level, message' }, 400);
  }

  const payload = {
    session_id: body.session_id || 'unknown',
    level: body.level,
    category: body.category || 'system',
    message: body.message,
    source: body.source || 'Unknown',
    meta: body.meta || {},
    stack_trace: body.stack_trace,
    user_agent: body.user_agent || request.headers.get('User-Agent'),
    url: body.url || request.headers.get('Referer'),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  };

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/console_logs`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation' // ขอข้อมูลที่ insert กลับมา
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase insert error: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  return jsonResponse({ success: true, data: result[0] }, 201);
}

async function handlePostBatch(request, env) {
  const body = await request.json();
  
  if (!body.logs || !Array.isArray(body.logs) || body.logs.length === 0) {
    return jsonResponse({ error: 'Missing or invalid logs array' }, 400);
  }

  // จำกัด batch size
  const logs = body.logs.slice(0, 100);
  
  const results = await Promise.allSettled(
    logs.map(log => insertSingleLog(env, log, request.headers))
  );

  const successful = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  return jsonResponse({
    success: true,
    total: logs.length,
    saved: successful,
    failed: failed
  }, 201);
}

// Helper สำหรับ insert รายตัว
async function insertSingleLog(env, log, headers) {
  const payload = {
    session_id: log.session_id || 'unknown',
    level: log.level,
    category: log.category || 'system',
    message: log.message,
    source: log.source || 'Unknown',
    meta: log.meta || {},
    stack_trace: log.stack_trace,
    user_agent: log.user_agent || headers.get('User-Agent'),
    url: log.url || headers.get('Referer'),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  };

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/console_logs`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Insert failed: ${response.status}`);
  }

  return { success: true };
}

// ============================================
// Utility Functions
// ============================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS
    }
  });
}


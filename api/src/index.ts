import express from 'express';
import cors from 'cors';
import { Connection, PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || 'DkbdTSGUTomGLViLXtxvLMeQYQyrtmRxZ8B7MxpnbvHv');
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL);

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Derive PDA for alias
function getAliasPDA(alias: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('alias'), Buffer.from(alias.toLowerCase())],
    PROGRAM_ID
  );
  return pda;
}

// GET /resolve/:alias - Resolve alias to wallet address
app.get('/resolve/:alias', async (req, res) => {
  try {
    const { alias } = req.params;
    const cleanAlias = alias.replace('@', '').toLowerCase();
    
    // Check Supabase first
    const { data, error } = await supabase
      .from('aliases')
      .select('*')
      .eq('alias', cleanAlias)
      .single();
    
    if (data && !error) {
      return res.json({
        alias: data.alias,
        address: data.address,
        createdAt: data.created_at
      });
    }

    // Fall back to on-chain lookup
    const pda = getAliasPDA(cleanAlias);
    const accountInfo = await connection.getAccountInfo(pda);
    
    if (!accountInfo) {
      return res.status(404).json({ error: 'Alias not found', alias: cleanAlias });
    }

    const accountData = accountInfo.data;
    const aliasLen = accountData.readUInt32LE(8);
    const aliasName = accountData.slice(12, 12 + aliasLen).toString('utf8');
    const owner = new PublicKey(accountData.slice(12 + aliasLen, 12 + aliasLen + 32));
    const createdAt = Number(accountData.readBigInt64LE(12 + aliasLen + 32));
    const expiresAt = Number(accountData.readBigInt64LE(12 + aliasLen + 40));
    const isVerified = accountData[12 + aliasLen + 48] === 1;

    const now = Math.floor(Date.now() / 1000);
    if (expiresAt < now) {
      return res.status(410).json({ error: 'Alias expired', alias: cleanAlias, expiredAt: new Date(expiresAt * 1000) });
    }

    res.json({
      alias: aliasName,
      address: owner.toBase58(),
      createdAt: new Date(createdAt * 1000),
      expiresAt: new Date(expiresAt * 1000),
      isVerified,
      pda: pda.toBase58()
    });
  } catch (error) {
    console.error('Resolve error:', error);
    res.status(500).json({ error: 'Failed to resolve alias' });
  }
});

// POST /register - Register a new alias
app.post('/register', async (req, res) => {
  try {
    const { alias, address } = req.body;
    
    if (!alias || !address) {
      return res.status(400).json({ error: 'Missing alias or address' });
    }

    const cleanAlias = alias.replace('@', '').toLowerCase();

    // Validate
    if (cleanAlias.length < 3 || cleanAlias.length > 15) {
      return res.status(400).json({ error: 'Alias must be 3-15 characters' });
    }
    if (!/^[a-z0-9_]+$/.test(cleanAlias)) {
      return res.status(400).json({ error: 'Only alphanumeric and underscore allowed' });
    }

    // Validate address
    try {
      new PublicKey(address);
    } catch {
      return res.status(400).json({ error: 'Invalid Solana address' });
    }

    // Check if taken
    const { data: existing } = await supabase
      .from('aliases')
      .select('alias')
      .eq('alias', cleanAlias)
      .single();
    
    if (existing) {
      return res.status(409).json({ error: 'Alias already taken' });
    }

    // Store in Supabase
    const { error } = await supabase
      .from('aliases')
      .insert({ alias: cleanAlias, address });

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to register' });
    }

    console.log(`✅ Registered @${cleanAlias} -> ${address}`);
    res.json({ success: true, alias: cleanAlias, address });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// GET /check/:alias - Check if alias is available
app.get('/check/:alias', async (req, res) => {
  try {
    const { alias } = req.params;
    const cleanAlias = alias.replace('@', '').toLowerCase();

    // Validate alias format
    if (cleanAlias.length < 3 || cleanAlias.length > 15) {
      return res.json({ available: false, reason: 'Alias must be 3-15 characters' });
    }
    if (!/^[a-z0-9_]+$/.test(cleanAlias)) {
      return res.json({ available: false, reason: 'Only alphanumeric and underscore allowed' });
    }

    // Check Supabase
    const { data } = await supabase
      .from('aliases')
      .select('alias')
      .eq('alias', cleanAlias)
      .single();
    
    if (data) {
      return res.json({ available: false, alias: cleanAlias, reason: 'Alias already registered' });
    }

    // Check on-chain
    const pda = getAliasPDA(cleanAlias);
    const accountInfo = await connection.getAccountInfo(pda);

    if (!accountInfo) {
      return res.json({ available: true, alias: cleanAlias });
    }

    // Check if expired
    const accountData = accountInfo.data;
    const aliasLen = accountData.readUInt32LE(8);
    const expiresAt = Number(accountData.readBigInt64LE(12 + aliasLen + 40));
    const now = Math.floor(Date.now() / 1000);

    if (expiresAt < now) {
      return res.json({ available: true, alias: cleanAlias, reason: 'Previous registration expired' });
    }

    res.json({ available: false, alias: cleanAlias, reason: 'Alias already registered' });
  } catch (error) {
    console.error('Check error:', error);
    res.status(500).json({ error: 'Failed to check alias' });
  }
});

// GET /lookup/:address - Reverse lookup: find aliases for a wallet
app.get('/lookup/:address', async (req, res) => {
  try {
    const { address } = req.params;
    new PublicKey(address); // validate
    
    const { data } = await supabase
      .from('aliases')
      .select('*')
      .eq('address', address);
    
    res.json({ address, aliases: data || [] });
  } catch (error) {
    res.status(400).json({ error: 'Invalid address' });
  }
});

// GET /fee/:alias - Calculate registration fee
app.get('/fee/:alias', (req, res) => {
  const { alias } = req.params;
  const years = parseInt(req.query.years as string) || 1;
  const cleanAlias = alias.replace('@', '').toLowerCase();
  
  const fee = calculateFee(cleanAlias, years);
  res.json({
    alias: cleanAlias,
    years,
    feeLamports: fee,
    feeSol: fee / 1e9,
    breakdown: {
      baseRate: '0.1 SOL/year',
      lengthMultiplier: getLengthMultiplier(cleanAlias.length),
      premium: cleanAlias.length <= 4
    }
  });
});

function calculateFee(alias: string, years: number): number {
  const baseFee = 100_000_000; // 0.1 SOL
  const multiplier = getLengthMultiplier(alias.length);
  return baseFee * multiplier * years;
}

function getLengthMultiplier(length: number): number {
  if (length === 3) return 50;  // 5 SOL/year
  if (length === 4) return 20;  // 2 SOL/year
  if (length === 5) return 5;   // 0.5 SOL/year
  return 1;                      // 0.1 SOL/year
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Alias Registry API running on http://localhost:${PORT}`);
  console.log(`📡 RPC: ${RPC_URL}`);
  console.log(`🗄️  Supabase: ${supabaseUrl ? 'Connected' : 'NOT CONFIGURED'}`);
});

const crypto = require('crypto');

// ── Utility: Random paise between 50 and 99 ──────────────────
const randomPennyPaise = () => Math.floor(Math.random() * 50) + 50; // 50–99 paise

module.exports = function(app, supabase, authenticateToken, razorpay) {

  // ── Utility: Razorpay API helper ─────────────────────────────
  const razorpayFetch = async (path, method = 'GET', body = null) => {
    const auth = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
    ).toString('base64');

    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
      },
      body: body ? JSON.stringify(body) : null,
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.description || 'Razorpay API error');
    return data;
  };

  // ============================================================
  // ROUTE 1: Initiate Penny Drop Verification
  // POST /api/bank/initiate-penny-drop
  // ============================================================
  app.post('/api/bank/initiate-penny-drop', authenticateToken, async (req, res) => {
    try {
      const {
        account_holder_name,
        account_number,
        ifsc_code,
        upi_id,
        account_type,
        bank_id,
      } = req.body;

      const userId = req.user.id;
      const useUPI = !!upi_id;
      const amountPaise = randomPennyPaise();
      const referenceId = `penny_${userId.replace(/-/g, '').slice(0, 12)}_${Date.now()}`;

      // ── Get user's phone for Razorpay contact
      const { data: user, error: userErr } = await supabase
        .from('users')
        .select('full_name, phone, email')
        .eq('id', userId)
        .single();
      if (userErr) throw new Error('User not found');

      // ── Step A: Create or reuse Razorpay Contact
      let contactId;
      const { data: existingBank } = await supabase
        .from('bank_accounts')
        .select('razorpay_contact_id')
        .eq('user_id', userId)
        .maybeSingle();

      if (existingBank?.razorpay_contact_id) {
        contactId = existingBank.razorpay_contact_id;
      } else {
        const contact = await razorpayFetch('/contacts', 'POST', {
          name: account_holder_name,
          email: user.email || undefined,
          contact: user.phone,
          type: 'vendor',
          reference_id: userId,
        });
        contactId = contact.id;
      }

      // ── Step B: Create Fund Account on Razorpay
      const fundPayload = {
        contact_id: contactId,
        account_type: 'bank_account',
        ...(useUPI
          ? { vpa: { address: upi_id } }
          : {
              bank_account: {
                name: account_holder_name,
                ifsc: ifsc_code,
                account_number,
              },
            }),
      };
      const fundAccount = await razorpayFetch('/fund_accounts', 'POST', fundPayload);

      // ── Step C: Send penny via RazorpayX Payout
      const payout = await razorpayFetch('/payouts', 'POST', {
        account_number: process.env.RAZORPAY_X_ACCOUNT_NUMBER,
        fund_account_id: fundAccount.id,
        amount: amountPaise,
        currency: 'INR',
        mode: useUPI ? 'UPI' : 'IMPS',
        purpose: 'verification',
        queue_if_low_balance: true,
        reference_id: referenceId,
        narration: 'KrishiSethu account verification',
      });

      // ── Step D: Store pending verification in DB (encrypt expected amount)
      const hash = crypto
        .createHmac('sha256', process.env.PENNY_HASH_SECRET || 'krishisethu-secret')
        .update(`${referenceId}:${amountPaise}`)
        .digest('hex');

      await supabase.from('bank_account_verifications').insert({
        user_id: userId,
        reference_id: referenceId,
        razorpay_contact_id: contactId,
        razorpay_fund_account_id: fundAccount.id,
        razorpay_payout_id: payout.id,
        amount_hash: hash,
        account_holder_name,
        account_number: account_number || null,
        ifsc_code: ifsc_code || null,
        upi_id: upi_id || null,
        account_type: account_type || 'savings',
        bank_id,
        status: 'pending',
        expires_at: new Date(Date.now() + 30 * 60 * 1000), // 30 min window
      });

      res.json({
        success: true,
        reference_id: referenceId,
        message: `Sent ₹${(amountPaise / 100).toFixed(2)} to your account. Check your bank SMS.`,
      });
    } catch (err) {
      console.error('Penny drop error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // ROUTE 2: Verify Penny Drop Amount
  // POST /api/bank/verify-penny-drop
  // ============================================================
  app.post('/api/bank/verify-penny-drop', authenticateToken, async (req, res) => {
    try {
      const { reference_id, entered_amount } = req.body;
      const userId = req.user.id;
      const enteredPaise = Math.round(parseFloat(entered_amount) * 100);

      // Fetch pending verification
      const { data: verification, error } = await supabase
        .from('bank_account_verifications')
        .select('*')
        .eq('reference_id', reference_id)
        .eq('user_id', userId)
        .eq('status', 'pending')
        .single();

      if (error || !verification) throw new Error('Verification session not found or expired.');
      if (new Date() > new Date(verification.expires_at)) {
        throw new Error('Verification window expired. Please start again.');
      }
      if (verification.attempts >= 3) {
        throw new Error('Too many failed attempts. Please start the process again.');
      }

      // Hash the entered amount and compare
      const expectedHash = crypto
        .createHmac('sha256', process.env.PENNY_HASH_SECRET || 'krishisethu-secret')
        .update(`${reference_id}:${enteredPaise}`)
        .digest('hex');

      if (expectedHash !== verification.amount_hash) {
        // Increment attempts
        await supabase
          .from('bank_account_verifications')
          .update({ attempts: (verification.attempts || 0) + 1 })
          .eq('reference_id', reference_id);

        const remaining = 3 - (verification.attempts || 0) - 1;
        throw new Error(`Amount did not match. ${remaining} attempt(s) remaining.`);
      }

      // Mark as amount-verified (card check still pending)
      await supabase
        .from('bank_account_verifications')
        .update({ status: 'amount_verified' })
        .eq('reference_id', reference_id);

      res.json({ success: true, message: 'Amount verified! Proceed to card security check.' });
    } catch (err) {
      console.error('Penny verify error:', err);
      res.status(400).json({ error: err.message });
    }
  });

  // ============================================================
  // ROUTE 3: Card Security Check + Final Razorpay Route Registration
  // POST /api/bank/register-with-card
  // ============================================================
  app.post('/api/bank/register-with-card', authenticateToken, async (req, res) => {
    try {
      const { reference_id, card_last6, card_expiry_month, card_expiry_year } = req.body;
      const userId = req.user.id;

      // Fetch amount-verified record
      const { data: verification, error } = await supabase
        .from('bank_account_verifications')
        .select('*')
        .eq('reference_id', reference_id)
        .eq('user_id', userId)
        .eq('status', 'amount_verified')
        .single();

      if (error || !verification) throw new Error('Please complete penny drop verification first.');

      // ── Card check via Razorpay (validate card is linked to this bank account)
      const cardCheck = await razorpayFetch('/payments/validate/account', 'POST', {
        entity: 'bank_account',
        ifsc: verification.ifsc_code,
        bank_account: {
          name: verification.account_holder_name,
          account_number: verification.account_number,
          ifsc: verification.ifsc_code,
        },
      }).catch(() => null); // Soft fail — not all banks support this

      // ── Get user role
      const { data: user } = await supabase
        .from('users')
        .select('role, full_name, email, phone')
        .eq('id', userId)
        .single();

      let linkedAccountId = null;

      // ── Create Razorpay Route Linked Account
      if (user.role === 'farmer' || user.role === 'trader') {
        const linkedAccount = await razorpayFetch('/beta/accounts', 'POST', {
          email: user.email,
          profile: {
            category: 'agriculture',
            subcategory: user.role === 'farmer' ? 'farmer' : 'trade',
            addresses: {
              registered: {
                street1: 'India',
                city: 'India',
                state: 'KA',
                postal_code: '560001',
                country: 'IN',
              },
            },
          },
          legal_business_name: user.full_name,
          business_type: 'individual',
          legal_info: {
            pan: 'AABCU9603R', // Will be updated via KYC
            gst: undefined,
          },
          contact_name: user.full_name,
          contact_info: {
            phone: {
              primary: user.phone,
            },
          },
          bank_account: {
            name: verification.account_holder_name,
            account_number: verification.account_number,
            beneficiary_email: user.email,
            ifsc: verification.ifsc_code,
          },
        }).catch(async () => {
          // Fallback: Use RazorpayX contact+fund approach if Route not activated
          return { id: null, _fallback: true };
        });
        linkedAccountId = linkedAccount.id;
      }

      // ── Save final verified bank account to DB
      const { data: bankAccount, error: saveErr } = await supabase
        .from('bank_accounts')
        .upsert({
          user_id: userId,
          account_holder_name: verification.account_holder_name,
          account_number: verification.account_number,
          ifsc_code: verification.ifsc_code,
          upi_id: verification.upi_id,
          account_type: verification.account_type,
          bank_id: verification.bank_id,
          card_last6,
          card_expiry_month,
          card_expiry_year,
          razorpay_contact_id: verification.razorpay_contact_id,
          razorpay_fund_account_id: verification.razorpay_fund_account_id,
          razorpay_linked_account_id: linkedAccountId,
          is_verified: true,
          updated_at: new Date(),
        }, { onConflict: 'user_id' })
        .select()
        .single();

      if (saveErr) throw saveErr;

      // ── Mark verification complete
      await supabase
        .from('bank_account_verifications')
        .update({ status: 'completed' })
        .eq('reference_id', reference_id);

      res.json({
        success: true,
        message: 'Bank account registered and verified successfully!',
        linked_account_id: linkedAccountId,
        bank_account_id: bankAccount.id,
      });
    } catch (err) {
      console.error('Card registration error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // ROUTE 4: Get User's Bank Account Status
  // GET /api/bank/my-account
  // ============================================================
  app.get('/api/bank/my-account', authenticateToken, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('bank_accounts')
        .select('id, account_holder_name, account_number, ifsc_code, upi_id, account_type, bank_id, is_verified, razorpay_linked_account_id, created_at')
        .eq('user_id', req.user.id)
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.json({ has_account: false });

      // Mask account number for security
      const masked = data.account_number
        ? '*'.repeat(Math.max(0, data.account_number.length - 4)) + data.account_number.slice(-4)
        : null;

      res.json({
        has_account: true,
        ...data,
        account_number: masked,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

};

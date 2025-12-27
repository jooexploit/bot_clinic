const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const cron = require("node-cron");
const config = require("./config");
const db = require("./database");

// ═══════════════════════════════════════════════════════════
// 🏥 بوت العيادة - نظام إدارة الدكاترة
// ═══════════════════════════════════════════════════════════

// Patient session tracking - تتبع جلسات المرضى
const patientSessions = new Map();

// Track notified patients about their active bookings (to send only once)
const notifiedActiveBookings = new Set();

// Session states - حالات الجلسة
const SESSION_STATES = {
  IDLE: "idle",
  AWAITING_DOCTOR_CHOICE: "awaiting_doctor_choice",
  AWAITING_PATIENT_NAME: "awaiting_patient_name",
  AWAITING_PATIENT_PHONE: "awaiting_patient_phone",
  AWAITING_VISIT_TYPE: "awaiting_visit_type",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  AWAITING_PAYMENT: "awaiting_payment",
  AWAITING_PAYMENT_PROOF: "awaiting_payment_proof",
  PAYMENT_SUBMITTED: "payment_submitted",
  BOOKING_CONFIRMED: "booking_confirmed",
};

// Visit types - أنواع الزيارة
const VISIT_TYPES = {
  NEW: "new",
  FOLLOWUP: "followup",
};

// ═══════════════════════════════════════════════════════════
// 🔧 Helper Functions - دوال مساعدة
// ═══════════════════════════════════════════════════════════

// Format message with placeholders
function formatMessage(template, data = {}) {
  let message = template;
  for (const [key, value] of Object.entries(data)) {
    message = message.replace(new RegExp(`{${key}}`, "g"), value);
  }
  return message;
}

// Get or create patient session
function getSession(chatId) {
  if (!patientSessions.has(chatId)) {
    patientSessions.set(chatId, {
      state: SESSION_STATES.IDLE,
      selectedDoctor: null,
      patientName: null,
      patientPhone: null,
      visitType: null,
      bookingId: null,
      lastActivity: Date.now(),
    });
  }
  const session = patientSessions.get(chatId);
  session.lastActivity = Date.now();
  return session;
}

// Update patient session
function updateSession(chatId, updates) {
  const session = getSession(chatId);
  Object.assign(session, updates, { lastActivity: Date.now() });
  patientSessions.set(chatId, session);
}

// Reset patient session (keep only essential data)
function resetSession(chatId) {
  patientSessions.set(chatId, {
    state: SESSION_STATES.IDLE,
    selectedDoctor: null,
    patientName: null,
    patientPhone: null,
    visitType: null,
    bookingId: null,
    lastActivity: Date.now(),
  });
}

// Clear old sessions
function clearOldSessions() {
  const timeoutMs = (config.SESSION?.TIMEOUT_MINUTES || 30) * 60 * 1000;
  const now = Date.now();
  for (const [chatId, session] of patientSessions.entries()) {
    if (now - session.lastActivity > timeoutMs) {
      patientSessions.delete(chatId);
    }
  }
}

// Run cleanup
const cleanupInterval = (config.SESSION?.CLEANUP_INTERVAL || 10) * 60 * 1000;
setInterval(clearOldSessions, cleanupInterval);

// ═══════════════════════════════════════════════════════════
// 🕐 Cutoff Time Functions - وظائف وقت الإغلاق
// ═══════════════════════════════════════════════════════════

// Get current time in Syria timezone
function getSyriaTime() {
  const timezone = config.CUTOFF_TIME?.TIMEZONE || "Asia/Damascus";
  return new Date().toLocaleString("en-US", { timeZone: timezone });
}

// Get Syria time as Date object
function getSyriaDate() {
  const timezone = config.CUTOFF_TIME?.TIMEZONE || "Asia/Damascus";
  const syriaTimeString = new Date().toLocaleString("en-US", {
    timeZone: timezone,
  });
  return new Date(syriaTimeString);
}

// Format time as HH:MM
function formatTime(hour, minute) {
  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}`;
}

// Check if booking is allowed based on cutoff time
function isBookingAllowed() {
  if (!config.CUTOFF_TIME?.ENABLED) {
    return true;
  }

  const syriaDate = getSyriaDate();
  const currentHour = syriaDate.getHours();
  const currentMinute = syriaDate.getMinutes();

  const cutoffHour = config.CUTOFF_TIME?.HOUR ?? 18;
  const cutoffMinute = config.CUTOFF_TIME?.MINUTE ?? 0;

  // Convert to minutes for easier comparison
  const currentTotalMinutes = currentHour * 60 + currentMinute;
  const cutoffTotalMinutes = cutoffHour * 60 + cutoffMinute;

  return currentTotalMinutes < cutoffTotalMinutes;
}

// Get formatted cutoff time message data
function getCutoffTimeInfo() {
  const syriaDate = getSyriaDate();
  const cutoffHour = config.CUTOFF_TIME?.HOUR ?? 18;
  const cutoffMinute = config.CUTOFF_TIME?.MINUTE ?? 0;

  return {
    cutoffTime: formatTime(cutoffHour, cutoffMinute),
    currentTime: formatTime(syriaDate.getHours(), syriaDate.getMinutes()),
    isEnabled: config.CUTOFF_TIME?.ENABLED ?? true,
    isBookingAllowed: isBookingAllowed(),
  };
}

// Update cutoff time in config (runtime only - persists in memory)
function updateCutoffTime(hour, minute) {
  if (!config.CUTOFF_TIME) {
    config.CUTOFF_TIME = {
      ENABLED: true,
      HOUR: 18,
      MINUTE: 0,
      TIMEZONE: "Asia/Damascus",
    };
  }
  config.CUTOFF_TIME.HOUR = hour;
  config.CUTOFF_TIME.MINUTE = minute;
}

// Enable/disable cutoff time system
function setCutoffTimeEnabled(enabled) {
  if (!config.CUTOFF_TIME) {
    config.CUTOFF_TIME = {
      ENABLED: enabled,
      HOUR: 18,
      MINUTE: 0,
      TIMEZONE: "Asia/Damascus",
    };
  } else {
    config.CUTOFF_TIME.ENABLED = enabled;
  }
}

// Track if summary was already sent today
let lastSummarySentDate = null;

// Store the cron job reference
let summaryCronJob = null;

// Store the daily cleanup cron job reference
let dailyCleanupCronJob = null;

// ═══════════════════════════════════════════════════════════
// 🧹 Daily Cleanup Function - تنظيف الحجوزات اليومي
// ═══════════════════════════════════════════════════════════

async function performDailyCleanup(sock) {
  console.log("🧹 Starting daily cleanup...");

  const syriaDate = getSyriaDate();
  const today = syriaDate.toLocaleDateString("ar-SA");

  // Clear all bookings
  const clearedCounts = db.clearAllBookings();

  // Clear all patient sessions
  const sessionCount = patientSessions.size;
  patientSessions.clear();

  // Clear notification tracking
  notifiedActiveBookings.clear();

  console.log(`🧹 Daily cleanup completed:`);
  console.log(
    `   - Cleared ${clearedCounts.confirmedBookings} confirmed bookings`
  );
  console.log(`   - Cleared ${clearedCounts.pendingPayments} pending payments`);
  console.log(`   - Cleared ${sessionCount} patient sessions`);

  // Notify admins about the cleanup
  const adminMessage = `🧹 *تم تنظيف بيانات الحجوزات*
══════════════════════════════

📅 *التاريخ:* ${today}
⏰ *الوقت:* ${formatTime(syriaDate.getHours(), syriaDate.getMinutes())}

📊 *تم حذف:*
• ${clearedCounts.confirmedBookings} حجز مؤكد
• ${clearedCounts.pendingPayments} حجز معلق
• ${sessionCount} جلسة مريض

✅ النظام جاهز لاستقبال حجوزات اليوم الجديد!

🏥 ${config.CLINIC_NAME}`;

  // Send to all admin numbers
  for (const adminNum of config.ADMIN_NUMBERS) {
    const adminJid = `${adminNum}@s.whatsapp.net`;
    try {
      await sock.sendMessage(adminJid, { text: adminMessage });
      console.log(`📤 Notified admin ${adminNum} about daily cleanup`);
    } catch (err) {
      console.log(`Failed to notify admin ${adminNum}: ${err.message}`);
    }
  }

  // Send to admin LIDs
  for (const adminLid of config.ADMIN_LIDS || []) {
    const adminJid = `${adminLid}@lid`;
    try {
      await sock.sendMessage(adminJid, { text: adminMessage });
      console.log(`📤 Notified admin LID ${adminLid} about daily cleanup`);
    } catch (err) {
      console.log(`Failed to notify admin LID ${adminLid}: ${err.message}`);
    }
  }

  return clearedCounts;
}

// Schedule daily cleanup at midnight (00:00) Syria time
function scheduleDailyCleanupCron(sock) {
  // Stop existing cron job if any
  if (dailyCleanupCronJob) {
    dailyCleanupCronJob.stop();
    console.log("⏰ Stopped previous daily cleanup cron job");
  }

  // Cron format: 0 0 * * * (every day at midnight)
  const cronExpression = "0 0 * * *";

  dailyCleanupCronJob = cron.schedule(
    cronExpression,
    async () => {
      console.log("🕛 Midnight cleanup cron job triggered!");
      await performDailyCleanup(sock);
    },
    {
      timezone: config.CUTOFF_TIME?.TIMEZONE || "Asia/Damascus",
    }
  );

  console.log(
    "⏰ Daily cleanup cron job scheduled: Every day at 00:00 (midnight Syria time)"
  );
}

// ═══════════════════════════════════════════════════════════
// 📤 Automatic Summary Function - إرسال الملخص التلقائي
// ═══════════════════════════════════════════════════════════

async function sendAutomaticSummary(sock) {
  console.log("🕐 Starting automatic summary...");

  const doctors = db.getAllDoctors();

  if (doctors.length === 0) {
    console.log("⚠️ No doctors found for automatic summary");
    return { sentResults: [], failedResults: [] };
  }

  const sentResults = [];
  const failedResults = [];
  const today = new Date().toLocaleDateString("ar-SA");

  for (const doctor of doctors) {
    try {
      const patients = db.getPatientsForDoctor(doctor.id);

      // Calculate stats
      const newVisits = patients.filter((p) => p.visitType === "new").length;
      const followupVisits = patients.filter(
        (p) => p.visitType === "followup"
      ).length;
      const totalRevenue = patients.reduce((sum, p) => sum + (p.price || 0), 0);

      // Build patients list
      let patientsList = "";
      if (patients.length === 0) {
        patientsList = config.MESSAGES.SUMMARY_NO_PATIENTS;
      } else {
        patients.forEach((patient, index) => {
          const visitTypeLabel =
            patient.visitType === "new" ? "كشف جديد" : "متابعة";
          patientsList += formatMessage(config.MESSAGES.SUMMARY_PATIENT_ITEM, {
            index: index + 1,
            patientName: patient.patientName,
            patientPhone: patient.patientPhone,
            visitType: visitTypeLabel,
            queuePosition: patient.queuePosition,
            price: patient.price,
            currency: config.PRICES.CURRENCY,
            date: new Date(
              patient.confirmedAt || patient.createdAt
            ).toLocaleString("ar-SA"),
          });
        });
      }

      // Build doctor message
      const doctorMessage = formatMessage(
        config.MESSAGES.SUMMARY_DOCTOR_MESSAGE,
        {
          date: today,
          doctorName: doctor.name,
          specialty: doctor.specialty,
          totalPatients: patients.length,
          newVisits: newVisits,
          followupVisits: followupVisits,
          totalRevenue: totalRevenue,
          currency: config.PRICES.CURRENCY,
          patientsList: patientsList,
          clinicName: config.CLINIC_NAME,
        }
      );

      // Send to doctor's WhatsApp
      const doctorJid = `${doctor.whatsapp}@s.whatsapp.net`;
      await sock.sendMessage(doctorJid, { text: doctorMessage });

      sentResults.push({
        doctorName: doctor.name,
        patientsCount: patients.length,
      });

      console.log(
        `📤 Auto-sent summary to Dr. ${doctor.name} (${patients.length} patients)`
      );

      // Small delay between messages
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(
        `Failed to send auto-summary to Dr. ${doctor.name}:`,
        error.message
      );
      failedResults.push({
        doctorName: doctor.name,
        error: error.message || "خطأ غير معروف",
      });
    }
  }

  return { sentResults, failedResults };
}

// Notify admins about automatic summary results
async function notifyAdminsAboutSummary(sock, sentResults, failedResults) {
  const cutoffInfo = getCutoffTimeInfo();
  const today = new Date().toLocaleDateString("ar-SA");

  // Build sent list
  let sentList =
    sentResults.length > 0
      ? sentResults
          .map((r) =>
            formatMessage(config.MESSAGES.AUTO_SUMMARY_SENT_ITEM, {
              doctorName: r.doctorName,
              patientsCount: r.patientsCount,
            })
          )
          .join("\n")
      : "_لا يوجد_";

  // Build failed list
  let failedList =
    failedResults.length > 0
      ? failedResults
          .map((r) =>
            formatMessage(config.MESSAGES.AUTO_SUMMARY_FAILED_ITEM, {
              doctorName: r.doctorName,
              error: r.error,
            })
          )
          .join("\n")
      : "_لا يوجد_";

  const adminMessage = formatMessage(
    config.MESSAGES.AUTO_SUMMARY_ADMIN_NOTIFICATION,
    {
      currentTime: cutoffInfo.currentTime,
      date: today,
      sentList: sentList,
      failedList: failedList,
      sentCount: sentResults.length,
      failedCount: failedResults.length,
      clinicName: config.CLINIC_NAME,
    }
  );

  // Send to all admin numbers
  for (const adminNum of config.ADMIN_NUMBERS) {
    const adminJid = `${adminNum}@s.whatsapp.net`;
    try {
      await sock.sendMessage(adminJid, { text: adminMessage });
      console.log(`📤 Notified admin ${adminNum} about auto-summary`);
    } catch (err) {
      console.log(`Failed to notify admin ${adminNum}: ${err.message}`);
    }
  }

  // Send to admin LIDs
  for (const adminLid of config.ADMIN_LIDS || []) {
    const adminJid = `${adminLid}@lid`;
    try {
      await sock.sendMessage(adminJid, { text: adminMessage });
      console.log(`📤 Notified admin LID ${adminLid} about auto-summary`);
    } catch (err) {
      console.log(`Failed to notify admin LID ${adminLid}: ${err.message}`);
    }
  }
}

// Schedule automatic summary using cron job
function scheduleSummaryCron(sock) {
  // Stop existing cron job if any
  if (summaryCronJob) {
    summaryCronJob.stop();
    console.log("⏰ Stopped previous cron job");
  }

  if (!config.CUTOFF_TIME?.ENABLED) {
    console.log("⏰ Cutoff time disabled - no cron job scheduled");
    return;
  }

  const cutoffHour = config.CUTOFF_TIME?.HOUR ?? 18;
  const cutoffMinute = config.CUTOFF_TIME?.MINUTE ?? 0;

  // Cron format: minute hour * * * (every day at specified time)
  const cronExpression = `${cutoffMinute} ${cutoffHour} * * *`;

  summaryCronJob = cron.schedule(
    cronExpression,
    async () => {
      console.log("🕐 Cron job triggered! Sending automatic summary...");

      const todayDateString = getSyriaDate().toDateString();

      // Double-check we haven't sent today (safety check)
      if (lastSummarySentDate === todayDateString) {
        console.log("⚠️ Summary already sent today, skipping...");
        return;
      }

      // Mark as sent for today
      lastSummarySentDate = todayDateString;

      // Send summaries to doctors
      const { sentResults, failedResults } = await sendAutomaticSummary(sock);

      // Notify admins about the results
      await notifyAdminsAboutSummary(sock, sentResults, failedResults);

      console.log(
        `📤 Automatic summary complete: ${sentResults.length} sent, ${failedResults.length} failed`
      );
    },
    {
      scheduled: true,
      timezone: config.CUTOFF_TIME?.TIMEZONE || "Asia/Damascus",
    }
  );

  console.log(
    `⏰ Cron job scheduled: Daily at ${formatTime(
      cutoffHour,
      cutoffMinute
    )} (Syria time)`
  );
}

// Get price based on visit type
function getPrice(visitType) {
  if (visitType === VISIT_TYPES.NEW) {
    return config.PRICES.NEW_CONSULTATION;
  }
  return config.PRICES.FOLLOWUP;
}

// Number to emoji converter
function getNumberEmoji(num) {
  const emojis = [
    "0️⃣",
    "1️⃣",
    "2️⃣",
    "3️⃣",
    "4️⃣",
    "5️⃣",
    "6️⃣",
    "7️⃣",
    "8️⃣",
    "9️⃣",
    "🔟",
  ];
  if (num >= 0 && num <= 10) return emojis[num];
  return `${num}.`;
}

// Convert Arabic/Eastern Arabic numerals to Western numerals
function convertArabicToWesternNumerals(str) {
  const arabicNumerals = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
  let result = str;
  arabicNumerals.forEach((arabic, index) => {
    result = result.replace(new RegExp(arabic, "g"), index.toString());
  });
  return result;
}

// Find doctor by number or name
function findDoctor(input, doctors) {
  const trimmed = convertArabicToWesternNumerals(input.trim());

  if (/^\d+$/.test(trimmed)) {
    const index = parseInt(trimmed) - 1;
    if (index >= 0 && index < doctors.length) {
      return doctors[index];
    }
  }

  const inputLower = trimmed.toLowerCase();
  return doctors.find(
    (doc) =>
      doc.name.toLowerCase().includes(inputLower) ||
      inputLower.includes(
        doc.name.toLowerCase().replace("د.", "").replace("دكتور", "").trim()
      )
  );
}

// Extract phone number from various formats
function extractNumber(jid) {
  if (!jid) return "";
  return jid
    .replace("@s.whatsapp.net", "")
    .replace("@g.us", "")
    .replace("@lid", "")
    .replace(":*", "")
    .split(":")[0];
}

// Check if user is admin
function isAdmin(identifier) {
  const cleanId = extractNumber(identifier);
  return (
    config.ADMIN_NUMBERS.includes(cleanId) ||
    config.ADMIN_LIDS?.includes(cleanId)
  );
}

// Get visit type label
function getVisitTypeLabel(visitType) {
  if (visitType === VISIT_TYPES.NEW) {
    return config.VISIT_TYPES.NEW.label;
  }
  return config.VISIT_TYPES.FOLLOWUP.label;
}

// ═══════════════════════════════════════════════════════════
// 📝 Message Generators - مولدات الرسائل
// ═══════════════════════════════════════════════════════════

// Patient welcome with doctors list
function generatePatientWelcome(doctors, patientName) {
  const MSG = config.MESSAGES;

  if (doctors.length === 0) {
    return formatMessage(MSG.PATIENT_WELCOME_NO_DOCTORS, { patientName });
  }

  let msg = formatMessage(MSG.PATIENT_WELCOME_HEADER, { patientName }) + "\n\n";
  msg += MSG.PATIENT_WELCOME_DOCTORS_HEADER + "\n";
  msg += "─".repeat(25) + "\n\n";

  doctors.forEach((doc, index) => {
    const num = index + 1;
    const emoji = getNumberEmoji(num);
    msg += `${emoji} *${doc.name}* – ${doc.specialty}\n`;
  });

  msg += "\n" + "─".repeat(25) + "\n\n";
  msg += MSG.PATIENT_WELCOME_FOOTER;

  return msg;
}

// Doctor selected message
function generateDoctorSelected(doctor) {
  return formatMessage(config.MESSAGES.DOCTOR_SELECTED, {
    doctorName: doctor.name,
    specialty: doctor.specialty,
  });
}

// Ask visit type message
function generateAskVisitType(patientName) {
  return formatMessage(config.MESSAGES.ASK_VISIT_TYPE, { patientName });
}

// Confirmation message
function generateConfirmBooking(session) {
  const visitTypeLabel = getVisitTypeLabel(session.visitType);
  return formatMessage(config.MESSAGES.CONFIRM_BOOKING, {
    doctorName: session.selectedDoctor.name,
    specialty: session.selectedDoctor.specialty,
    patientName: session.patientName,
    patientPhone: session.patientPhone,
    visitType: visitTypeLabel,
  });
}

// Payment message
function generatePaymentMessage(session, bookingId) {
  const MSG = config.MESSAGES;
  const price = getPrice(session.visitType);
  const visitTypeLabel = getVisitTypeLabel(session.visitType);

  // Get next day's date (appointment date)
  const nextDay = getSyriaDate();
  nextDay.setDate(nextDay.getDate() + 1);
  const bookingDate = nextDay.toLocaleDateString("ar-SA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  let msg = MSG.PAYMENT_HEADER + "\n\n";

  msg +=
    formatMessage(MSG.PAYMENT_BOOKING_DETAILS, {
      bookingId: bookingId,
      bookingDate: bookingDate,
      doctorName: session.selectedDoctor.name,
      specialty: session.selectedDoctor.specialty,
      patientName: session.patientName,
      visitType: visitTypeLabel,
    }) + "\n\n";

  msg +=
    formatMessage(MSG.PAYMENT_AMOUNT, {
      price: price,
      currency: config.PRICES.CURRENCY,
    }) + "\n\n";

  msg += MSG.PAYMENT_METHODS_HEADER + "\n\n";

  if (config.PAYMENT_METHODS.BANK_TRANSFER?.enabled) {
    const bank = config.PAYMENT_METHODS.BANK_TRANSFER;
    msg +=
      formatMessage(MSG.PAYMENT_BANK_FORMAT, {
        name: bank.name,
        bankName: bank.bankName,
        accountName: bank.accountName,
        iban: bank.iban,
      }) + "\n\n";
  }

  if (config.PAYMENT_METHODS.SYRIATEL_CASH?.enabled) {
    const syriatel = config.PAYMENT_METHODS.SYRIATEL_CASH;
    msg +=
      formatMessage(MSG.PAYMENT_STC_FORMAT, {
        name: syriatel.name,
        number: syriatel.number,
      }) + "\n\n";
  }

  msg += MSG.PAYMENT_FOOTER;

  return msg;
}

// Payment proof received
function generatePaymentProofReceived(bookingId) {
  return formatMessage(config.MESSAGES.PAYMENT_PROOF_RECEIVED, { bookingId });
}

// Admin new payment notification
function generateAdminNewPayment(booking) {
  const visitTypeLabel = getVisitTypeLabel(booking.visitType);
  return formatMessage(config.MESSAGES.ADMIN_NEW_PAYMENT, {
    bookingId: booking.id,
    patientName: booking.patientName,
    patientPhone: booking.patientPhone,
    chatId: booking.chatId,
    doctorName: booking.doctorName,
    specialty: booking.doctorSpecialty,
    visitType: visitTypeLabel,
    price: booking.price,
    currency: config.PRICES.CURRENCY,
  });
}

// Payment confirmed to patient
function generatePaymentConfirmedToPatient(booking) {
  const visitTypeLabel = getVisitTypeLabel(booking.visitType);

  // Get next day's date from booking creation (appointment date)
  const nextDay = new Date(booking.createdAt);
  nextDay.setDate(nextDay.getDate() + 1);
  const bookingDate = nextDay.toLocaleDateString("ar-SA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return formatMessage(config.MESSAGES.PAYMENT_CONFIRMED_TO_PATIENT, {
    bookingId: booking.id,
    bookingDate: bookingDate,
    doctorName: booking.doctorName,
    specialty: booking.doctorSpecialty,
    patientName: booking.patientName,
    visitType: visitTypeLabel,
    queuePosition: booking.queuePosition,
  });
}

// Payment rejected to patient
function generatePaymentRejectedToPatient(booking, reason) {
  return formatMessage(config.MESSAGES.PAYMENT_REJECTED_TO_PATIENT, {
    bookingId: booking.id,
    reason: reason ? `📝 *السبب:* ${reason}\n` : "",
  });
}

// Admin pending payments list
function generateAdminPendingPayments(payments) {
  const MSG = config.MESSAGES;

  if (payments.length === 0) {
    return MSG.ADMIN_PENDING_PAYMENTS_EMPTY;
  }

  let msg =
    formatMessage(MSG.ADMIN_PENDING_PAYMENTS_HEADER, {
      count: payments.length,
    }) + "\n\n";

  payments.forEach((p, index) => {
    const visitTypeLabel = p.visitType === VISIT_TYPES.NEW ? "جديد" : "متابعة";
    msg +=
      formatMessage(MSG.ADMIN_PENDING_PAYMENT_ITEM, {
        index: index + 1,
        bookingId: p.id,
        patientName: p.patientName,
        doctorName: p.doctorName,
        visitType: visitTypeLabel,
        price: p.price,
        currency: config.PRICES.CURRENCY,
        date: new Date(p.updatedAt).toLocaleString("ar-SA"),
      }) + "\n\n";
  });

  msg += MSG.ADMIN_PENDING_PAYMENTS_FOOTER;

  return msg;
}

// Doctor added message
function generateDoctorAdded(doctor) {
  return formatMessage(config.MESSAGES.DOCTOR_ADDED, {
    id: doctor.id,
    name: doctor.name,
    specialty: doctor.specialty,
    whatsapp: doctor.whatsapp,
  });
}

// Doctor removed message
function generateDoctorRemoved(doctor) {
  return formatMessage(config.MESSAGES.DOCTOR_REMOVED, {
    name: doctor.name,
    specialty: doctor.specialty,
  });
}

// Doctors list (admin view)
function generateDoctorsList(doctors) {
  const MSG = config.MESSAGES;

  if (doctors.length === 0) {
    return MSG.DOCTORS_LIST_EMPTY;
  }

  let list = MSG.DOCTORS_LIST_HEADER + "\n\n";

  doctors.forEach((doc, index) => {
    list +=
      formatMessage(MSG.DOCTORS_LIST_ITEM, {
        index: index + 1,
        id: doc.id,
        name: doc.name,
        specialty: doc.specialty,
        whatsapp: doc.whatsapp,
      }) + "\n\n";
  });

  list += formatMessage(MSG.DOCTORS_LIST_FOOTER, { count: doctors.length });

  return list;
}

// Doctors list (patient view)
function generateShowDoctorsList(doctors) {
  const MSG = config.MESSAGES;

  if (doctors.length === 0) {
    return MSG.SHOW_DOCTORS_EMPTY;
  }

  let msg = MSG.SHOW_DOCTORS_HEADER + "\n\n";

  doctors.forEach((doc, index) => {
    const num = index + 1;
    const emoji = getNumberEmoji(num);
    msg += `${emoji} *${doc.name}* – ${doc.specialty}\n`;
  });

  msg += "\n" + MSG.SHOW_DOCTORS_FOOTER;

  return msg;
}

// Help menu
function generateHelpMenu() {
  return config.MESSAGES.HELP_MENU + `🏥 *${config.BOT_NAME}*`;
}

// ═══════════════════════════════════════════════════════════
// 🚀 Main Bot Function - الدالة الرئيسية للبوت
// ═══════════════════════════════════════════════════════════

async function startBot() {
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(
    `📦 Using Baileys v${version.join(".")} ${isLatest ? "(Latest)" : ""}`
  );

  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["بوت العيادة", "Chrome", "120.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Handle QR code display
    if (qr) {
      console.log("📱 Scan this QR code to login:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`❌ Connection closed. Status: ${statusCode}`);

      if (shouldReconnect) {
        console.log("🔄 Reconnecting...");
        setTimeout(startBot, 3000);
      } else {
        console.log(
          "🚫 Logged out. Please delete auth_info folder and restart."
        );
      }
    } else if (connection === "open") {
      console.log("✅ البوت متصل بنجاح! 🏥");
      console.log("📱 Bot is ready to receive messages");

      // Schedule automatic summary using cron job
      scheduleSummaryCron(sock);

      // Schedule daily cleanup at midnight
      scheduleDailyCleanupCron(sock);
    }
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return;

    const msg = msgs[0];
    if (!msg.message || msg.key.fromMe) return;

    const chatId = msg.key.remoteJid;
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const senderName = msg.pushName || "Unknown";
    const senderNumber = senderJid;

    // Debug: Log all message keys
    console.log(`🔍 DEBUG - All message keys:`, Object.keys(msg.message));

    // Determine message type - skip protocol messages
    const messageKeys = Object.keys(msg.message).filter(
      (key) =>
        key !== "messageContextInfo" &&
        key !== "senderKeyDistributionMessage" &&
        key !== "protocolMessage"
    );
    const messageType = messageKeys[0] || Object.keys(msg.message)[0];
    const isImage = messageType === "imageMessage";
    const isText =
      messageType === "conversation" || messageType === "extendedTextMessage";

    // Get message text
    let messageText = "";
    if (msg.message.conversation) {
      messageText = msg.message.conversation;
    } else if (msg.message.extendedTextMessage?.text) {
      messageText = msg.message.extendedTextMessage.text;
    } else if (msg.message.imageMessage?.caption) {
      messageText = msg.message.imageMessage.caption;
    }

    const text = messageText.trim();
    const textLower = text.toLowerCase();

    const cleanId = extractNumber(senderNumber);
    const isLID = senderNumber.includes("@lid");
    const adminStatus = isAdmin(senderNumber);

    console.log(`📩 Message from ${senderName} (${senderNumber})`);
    console.log(`📨 Message type: ${messageType}`);
    console.log(`📝 Text: ${text || "[No text]"}`);
    console.log(`🖼️ Is Image: ${isImage}`);
    console.log(`👑 Is Admin: ${adminStatus}`);

    const session = getSession(chatId);
    console.log(`📋 Session state: ${session.state}`);

    // ═══════════════════════════════════════════════════════════
    // Handle Image Messages (Payment Proof)
    // ═══════════════════════════════════════════════════════════
    if (isImage) {
      console.log(`📸 Processing image. Booking ID: ${session.bookingId}`);

      // Check for active booking if session doesn't have bookingId
      let activeBookingId = session.bookingId;
      if (!activeBookingId) {
        const activeBooking = db.getActiveBookingByChatId(chatId);
        if (activeBooking && activeBooking.status === "awaiting_payment") {
          activeBookingId = activeBooking.id;
          // Update session with active booking info
          updateSession(chatId, {
            state: SESSION_STATES.AWAITING_PAYMENT_PROOF,
            bookingId: activeBooking.id,
            selectedDoctor: {
              id: activeBooking.doctorId,
              name: activeBooking.doctorName,
              specialty: activeBooking.doctorSpecialty,
            },
            patientName: activeBooking.patientName,
            patientPhone: activeBooking.patientPhone,
            visitType: activeBooking.visitType,
          });
        }
      }

      // Verify booking exists in database before processing
      const bookingInDb = db.getPendingPaymentById(activeBookingId);
      if (!bookingInDb) {
        console.log(
          `⚠️ Booking #${activeBookingId} not found in database, resetting session`
        );
        resetSession(chatId);
        await sock.sendMessage(chatId, {
          text: `⚠️ *لم يتم العثور على حجز نشط*\n\nيبدو أن جلستك انتهت. أرسل "مرحبا" للبدء من جديد.`,
        });
        return;
      }

      if (
        (session.state === SESSION_STATES.AWAITING_PAYMENT_PROOF ||
          activeBookingId) &&
        activeBookingId
      ) {
        try {
          let stream = null;

          // Try to download the image, but don't fail if it doesn't work
          try {
            const imageMessage = msg.message.imageMessage;
            stream = await downloadMediaMessage(
              msg,
              "buffer",
              {},
              {
                logger: pino({ level: "silent" }),
                reuploadRequest: sock.updateMediaMessage,
              }
            );
          } catch (downloadError) {
            console.log(
              `⚠️ Could not download image: ${downloadError.message}`
            );
            // Continue without the image - we'll still process the payment
          }

          const updatedPayment = db.submitPaymentProof(
            activeBookingId,
            "image_received"
          );

          if (updatedPayment) {
            updateSession(chatId, { state: SESSION_STATES.PAYMENT_SUBMITTED });

            // Clear notification tracking since booking status changed
            notifiedActiveBookings.delete(chatId);

            await sock.sendMessage(chatId, {
              text: generatePaymentProofReceived(activeBookingId),
            });

            const adminMessage = generateAdminNewPayment(updatedPayment);

            // Send to admin numbers
            for (const adminNum of config.ADMIN_NUMBERS) {
              const adminJid = `${adminNum}@s.whatsapp.net`;
              try {
                if (stream) {
                  await sock.sendMessage(adminJid, {
                    image: stream,
                    caption: adminMessage,
                  });
                } else {
                  // Send text only if image download failed
                  await sock.sendMessage(adminJid, {
                    text: adminMessage + "\n\n⚠️ _تعذر تحميل صورة الإيصال_",
                  });
                }
              } catch (err) {
                console.log(
                  `Failed to send to admin ${adminNum}: ${err.message}`
                );
              }
            }

            // Send to admin LIDs
            for (const adminLid of config.ADMIN_LIDS || []) {
              const adminJid = `${adminLid}@lid`;
              try {
                if (stream) {
                  await sock.sendMessage(adminJid, {
                    image: stream,
                    caption: adminMessage,
                  });
                } else {
                  // Send text only if image download failed
                  await sock.sendMessage(adminJid, {
                    text: adminMessage + "\n\n⚠️ _تعذر تحميل صورة الإيصال_",
                  });
                }
              } catch (err) {
                console.log(
                  `Failed to send to admin LID ${adminLid}: ${err.message}`
                );
              }
            }

            console.log(
              `📸 Payment proof received for booking #${activeBookingId}`
            );
          } else {
            // Booking not found in DB
            console.log(
              `⚠️ Booking #${activeBookingId} not found when submitting payment`
            );
            resetSession(chatId);
            await sock.sendMessage(chatId, {
              text: `⚠️ *لم يتم العثور على الحجز*\n\nأرسل "مرحبا" للبدء من جديد.`,
            });
          }
        } catch (error) {
          console.error("Error processing payment image:", error);
          await sock.sendMessage(chatId, { text: config.MESSAGES.IMAGE_ERROR });
        }
        return;
      }

      console.log(
        `📸 Image received but not in payment state. State: ${session.state}`
      );
      await sock.sendMessage(chatId, {
        text: config.MESSAGES.IMAGE_RECEIVED_NO_BOOKING,
      });
      return;
    }

    if (!messageText) return;

    // ═══════════════════════════════════════════════════════════
    // Command Handlers
    // ═══════════════════════════════════════════════════════════

    // Admin Check Command
    if (textLower === "!تحقق" || textLower === "!check") {
      const checkMessage = `🔍 *فحص صلاحيات المستخدم*
${"═".repeat(30)}

👤 *اسمك:* ${senderName}

📱 *معرفك الكامل (JID):*
\`${senderNumber}\`

🔢 *المعرف النظيف:*
\`${cleanId}\`

🏷️ *نوع المعرف:* ${isLID ? "LID (معرف واتساب داخلي)" : "رقم جوال عادي"}

📋 *أرقام الأدمن المسجلة:*
${config.ADMIN_NUMBERS.map((n) => `• \`${n}\``).join("\n") || "• لا يوجد"}

📋 *معرفات LID للأدمن:*
${config.ADMIN_LIDS?.map((n) => `• \`${n}\``).join("\n") || "• لا يوجد"}

👑 *هل أنت أدمن؟:* ${adminStatus ? "✅ نعم!" : "❌ لا"}

${
  !adminStatus
    ? `
⚠️ *السبب:* معرفك \`${cleanId}\` مو موجود في القائمة

💡 *الحل:* روح لملف config.js وأضف معرفك:
${
  isLID
    ? `
\`\`\`
ADMIN_LIDS: [
    '${cleanId}',
],
\`\`\`
`
    : `
\`\`\`
ADMIN_NUMBERS: [
    '${cleanId}',
],
\`\`\`
`
}`
    : "🎉 أنت أدمن! تقدر تستخدم كل الأوامر"
}`;

      await sock.sendMessage(chatId, { text: checkMessage });
      return;
    }

    // Manual Cleanup Command (Admin only)
    if (textLower === "!تنظيف" || textLower === "!cleanup") {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const clearedCounts = db.clearAllBookings();
      const sessionCount = patientSessions.size;
      patientSessions.clear();
      notifiedActiveBookings.clear();

      const syriaDate = getSyriaDate();
      const cleanupMessage = `🧹 *تم تنظيف جميع الحجوزات يدوياً*
══════════════════════════════

📅 *التاريخ:* ${syriaDate.toLocaleDateString("ar-SA")}
⏰ *الوقت:* ${formatTime(syriaDate.getHours(), syriaDate.getMinutes())}

📊 *تم حذف:*
• ${clearedCounts.confirmedBookings} حجز مؤكد
• ${clearedCounts.pendingPayments} حجز معلق
• ${sessionCount} جلسة مريض

✅ النظام جاهز لاستقبال حجوزات جديدة!`;

      await sock.sendMessage(chatId, { text: cleanupMessage });
      console.log(`🧹 Admin ${senderName} triggered manual cleanup`);
      return;
    }

    // Ping-Pong
    if (textLower === "ping") {
      await sock.sendMessage(chatId, { text: config.MESSAGES.PONG });
      return;
    }

    // Help Menu
    if (
      textLower === "!مساعدة" ||
      textLower === "!help" ||
      textLower === "مساعدة" ||
      textLower === "help" ||
      textLower === "مساعده"
    ) {
      await sock.sendMessage(chatId, { text: generateHelpMenu() });
      return;
    }

    // List Doctors (Admin view)
    if (textLower === "!الدكاترة" || textLower === "!doctors") {
      const doctors = db.getAllDoctors();
      await sock.sendMessage(chatId, { text: generateDoctorsList(doctors) });
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // Admin-Only Commands (MUST BE BEFORE Patient Flow)
    // ═══════════════════════════════════════════════════════════

    // Add Doctor Command
    if (text.startsWith("!اضافة_دكتور") || text.startsWith("!add_doctor")) {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const commandPart = text
        .replace("!اضافة_دكتور", "")
        .replace("!add_doctor", "")
        .trim();
      const parts = commandPart.split("|").map((p) => p.trim());

      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.INVALID_ADD_DOCTOR_FORMAT,
        });
        return;
      }

      const [name, specialty, whatsapp] = parts;
      const newDoctor = db.addDoctor(name, specialty, whatsapp);

      await sock.sendMessage(chatId, { text: generateDoctorAdded(newDoctor) });
      console.log(`✅ Admin added doctor: ${name}`);
      return;
    }

    // Remove Doctor Command
    if (text.startsWith("!حذف_دكتور") || text.startsWith("!remove_doctor")) {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const identifier = text
        .replace("!حذف_دكتور", "")
        .replace("!remove_doctor", "")
        .trim();

      if (!identifier) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.INVALID_REMOVE_DOCTOR_FORMAT,
        });
        return;
      }

      let removed;
      if (/^\d+$/.test(identifier)) {
        removed = db.removeDoctorById(identifier);
      } else {
        removed = db.removeDoctorByName(identifier);
      }

      if (!removed) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.DOCTOR_NOT_FOUND,
        });
        return;
      }

      await sock.sendMessage(chatId, { text: generateDoctorRemoved(removed) });
      console.log(`✅ Admin removed doctor: ${removed.name}`);
      return;
    }

    // View Pending Payments
    if (
      textLower === "!الدفعات" ||
      textLower === "!pending" ||
      textLower === "!payments"
    ) {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const pendingPayments = db.getAllPendingPayments();
      await sock.sendMessage(chatId, {
        text: generateAdminPendingPayments(pendingPayments),
      });
      return;
    }

    // Confirm Payment Command
    if (
      text.startsWith("!تأكيد_دفع") ||
      text.startsWith("!confirm_payment") ||
      text.startsWith("!تاكيد_دفع")
    ) {
      console.log("🔔 Confirm payment command received");

      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const bookingId = text
        .replace("!تأكيد_دفع", "")
        .replace("!تاكيد_دفع", "")
        .replace("!confirm_payment", "")
        .trim();

      console.log(`🔔 Booking ID to confirm: ${bookingId}`);

      if (!bookingId || !/^\d+$/.test(bookingId)) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.ADMIN_CONFIRM_INVALID_FORMAT,
        });
        return;
      }

      const confirmedBooking = db.confirmBooking(bookingId);

      if (!confirmedBooking) {
        await sock.sendMessage(chatId, {
          text: formatMessage(config.MESSAGES.ADMIN_CONFIRM_NOT_FOUND, {
            bookingId,
          }),
        });
        return;
      }

      // Notify patient
      try {
        await sock.sendMessage(confirmedBooking.chatId, {
          text: generatePaymentConfirmedToPatient(confirmedBooking),
        });
      } catch (err) {
        console.log(`Failed to notify patient: ${err.message}`);
      }

      // Clear notification tracking for this patient
      notifiedActiveBookings.delete(confirmedBooking.chatId);

      if (patientSessions.has(confirmedBooking.chatId)) {
        updateSession(confirmedBooking.chatId, {
          state: SESSION_STATES.BOOKING_CONFIRMED,
        });
      }

      await sock.sendMessage(chatId, {
        text: formatMessage(config.MESSAGES.ADMIN_CONFIRM_SUCCESS, {
          bookingId: confirmedBooking.id,
          patientName: confirmedBooking.patientName,
          doctorName: confirmedBooking.doctorName,
          queuePosition: confirmedBooking.queuePosition,
        }),
      });

      console.log(`✅ Admin confirmed payment for booking #${bookingId}`);
      return;
    }

    // Reject Payment Command
    if (text.startsWith("!رفض_دفع") || text.startsWith("!reject_payment")) {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const parts = text
        .replace("!رفض_دفع", "")
        .replace("!reject_payment", "")
        .trim()
        .split(" ");
      const bookingId = parts[0];
      const reason = parts.slice(1).join(" ") || "";

      if (!bookingId || !/^\d+$/.test(bookingId)) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.ADMIN_REJECT_INVALID_FORMAT,
        });
        return;
      }

      const rejectedBooking = db.rejectBooking(bookingId, reason);

      if (!rejectedBooking) {
        await sock.sendMessage(chatId, {
          text: formatMessage(config.MESSAGES.ADMIN_REJECT_NOT_FOUND, {
            bookingId,
          }),
        });
        return;
      }

      // Clear notification tracking for this patient
      notifiedActiveBookings.delete(rejectedBooking.chatId);

      // Notify patient
      try {
        await sock.sendMessage(rejectedBooking.chatId, {
          text: generatePaymentRejectedToPatient(rejectedBooking, reason),
        });

        if (patientSessions.has(rejectedBooking.chatId)) {
          updateSession(rejectedBooking.chatId, {
            state: SESSION_STATES.AWAITING_PAYMENT_PROOF,
          });
        }
      } catch (err) {
        console.log(`Failed to notify patient: ${err.message}`);
      }

      await sock.sendMessage(chatId, {
        text: formatMessage(config.MESSAGES.ADMIN_REJECT_SUCCESS, {
          bookingId: rejectedBooking.id,
          patientName: rejectedBooking.patientName,
          reason: reason ? `📝 السبب: ${reason}` : "",
        }),
      });

      console.log(`❌ Admin rejected payment for booking #${bookingId}`);
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // Summary Command - إرسال ملخص المرضى لكل دكتور
    // ═══════════════════════════════════════════════════════════

    if (textLower === "!ملخص" || textLower === "!summary") {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const doctors = db.getAllDoctors();

      if (doctors.length === 0) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.SUMMARY_NO_DOCTORS,
        });
        return;
      }

      // Send "sending" message
      await sock.sendMessage(chatId, {
        text: config.MESSAGES.SUMMARY_SENDING,
      });

      const sentResults = [];
      const failedResults = [];
      const today = new Date().toLocaleDateString("ar-SA");

      for (const doctor of doctors) {
        try {
          const patients = db.getPatientsForDoctor(doctor.id);

          // Calculate stats
          const newVisits = patients.filter(
            (p) => p.visitType === "new"
          ).length;
          const followupVisits = patients.filter(
            (p) => p.visitType === "followup"
          ).length;
          const totalRevenue = patients.reduce(
            (sum, p) => sum + (p.price || 0),
            0
          );

          // Build patients list
          let patientsList = "";
          if (patients.length === 0) {
            patientsList = config.MESSAGES.SUMMARY_NO_PATIENTS;
          } else {
            patients.forEach((patient, index) => {
              const visitTypeLabel =
                patient.visitType === "new" ? "كشف جديد" : "متابعة";
              patientsList += formatMessage(
                config.MESSAGES.SUMMARY_PATIENT_ITEM,
                {
                  index: index + 1,
                  patientName: patient.patientName,
                  patientPhone: patient.patientPhone,
                  visitType: visitTypeLabel,
                  queuePosition: patient.queuePosition,
                  price: patient.price,
                  currency: config.PRICES.CURRENCY,
                  date: new Date(
                    patient.confirmedAt || patient.createdAt
                  ).toLocaleString("ar-SA"),
                }
              );
            });
          }

          // Build doctor message
          const doctorMessage = formatMessage(
            config.MESSAGES.SUMMARY_DOCTOR_MESSAGE,
            {
              date: today,
              doctorName: doctor.name,
              specialty: doctor.specialty,
              totalPatients: patients.length,
              newVisits: newVisits,
              followupVisits: followupVisits,
              totalRevenue: totalRevenue,
              currency: config.PRICES.CURRENCY,
              patientsList: patientsList,
              clinicName: config.CLINIC_NAME,
            }
          );

          // Send to doctor's WhatsApp
          const doctorJid = `${doctor.whatsapp}@s.whatsapp.net`;
          await sock.sendMessage(doctorJid, { text: doctorMessage });

          sentResults.push({
            doctorName: doctor.name,
            patientsCount: patients.length,
          });

          console.log(
            `📤 Sent summary to Dr. ${doctor.name} (${patients.length} patients)`
          );

          // Small delay between messages
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Failed to send to Dr. ${doctor.name}:`, error.message);
          failedResults.push({
            doctorName: doctor.name,
            error: error.message || "خطأ غير معروف",
          });
        }
      }

      // Build result message
      let sentList =
        sentResults.length > 0
          ? sentResults
              .map((r) =>
                formatMessage(config.MESSAGES.SUMMARY_SENT_ITEM, {
                  doctorName: r.doctorName,
                  patientsCount: r.patientsCount,
                })
              )
              .join("\n")
          : "_لا يوجد_";

      let failedList =
        failedResults.length > 0
          ? failedResults
              .map((r) =>
                formatMessage(config.MESSAGES.SUMMARY_FAILED_ITEM, {
                  doctorName: r.doctorName,
                  error: r.error,
                })
              )
              .join("\n")
          : "_لا يوجد_";

      await sock.sendMessage(chatId, {
        text: formatMessage(config.MESSAGES.SUMMARY_COMPLETE, {
          sentList: sentList,
          failedList: failedList,
          sentCount: sentResults.length,
          failedCount: failedResults.length,
        }),
      });

      console.log(
        `📤 Summary sent: ${sentResults.length} success, ${failedResults.length} failed`
      );
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // Cutoff Time Command - أمر وقت الإغلاق
    // ═══════════════════════════════════════════════════════════

    if (
      text.startsWith("!وقت_الاغلاق") ||
      text.startsWith("!cutoff") ||
      text.startsWith("!وقت_الإغلاق")
    ) {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const args = text
        .replace("!وقت_الاغلاق", "")
        .replace("!وقت_الإغلاق", "")
        .replace("!cutoff", "")
        .trim();

      const cutoffInfo = getCutoffTimeInfo();

      // Show status if no arguments
      if (!args) {
        const statusMessage = formatMessage(
          config.MESSAGES.CUTOFF_TIME_STATUS,
          {
            enabled: cutoffInfo.isEnabled ? "✅ مفعّل" : "❌ معطّل",
            cutoffTime: cutoffInfo.cutoffTime,
            currentTime: cutoffInfo.currentTime,
            bookingStatus: cutoffInfo.isBookingAllowed
              ? "🟢 الحجوزات مفتوحة حالياً"
              : "🔴 الحجوزات مغلقة حالياً",
          }
        );
        await sock.sendMessage(chatId, { text: statusMessage });
        return;
      }

      // Enable cutoff system
      if (args === "تفعيل" || args === "enable" || args === "on") {
        setCutoffTimeEnabled(true);
        scheduleSummaryCron(sock); // Reschedule cron job
        const newCutoffInfo = getCutoffTimeInfo();
        await sock.sendMessage(chatId, {
          text: formatMessage(config.MESSAGES.CUTOFF_TIME_SET, {
            cutoffTime: newCutoffInfo.cutoffTime,
            currentTime: newCutoffInfo.currentTime,
            status: "✅ تم تفعيل نظام وقت الإغلاق",
          }),
        });
        console.log(`⏰ Admin enabled cutoff time system`);
        return;
      }

      // Disable cutoff system
      if (
        args === "ايقاف" ||
        args === "إيقاف" ||
        args === "disable" ||
        args === "off"
      ) {
        setCutoffTimeEnabled(false);
        // Stop cron job
        if (summaryCronJob) {
          summaryCronJob.stop();
          summaryCronJob = null;
          console.log("⏰ Cron job stopped");
        }
        const newCutoffInfo = getCutoffTimeInfo();
        await sock.sendMessage(chatId, {
          text: formatMessage(config.MESSAGES.CUTOFF_TIME_SET, {
            cutoffTime: newCutoffInfo.cutoffTime,
            currentTime: newCutoffInfo.currentTime,
            status: "❌ تم إيقاف نظام وقت الإغلاق - الحجوزات مفتوحة 24 ساعة",
          }),
        });
        console.log(`⏰ Admin disabled cutoff time system`);
        return;
      }

      // Parse time format (HH:MM or HH)
      const timeMatch = args.match(/^(\d{1,2}):?(\d{2})?$/);
      if (!timeMatch) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.CUTOFF_TIME_INVALID_FORMAT,
        });
        return;
      }

      const hour = parseInt(timeMatch[1]);
      const minute = parseInt(timeMatch[2] || "0");

      // Validate hour and minute
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.CUTOFF_TIME_INVALID_FORMAT,
        });
        return;
      }

      // Update cutoff time
      updateCutoffTime(hour, minute);
      setCutoffTimeEnabled(true);
      scheduleSummaryCron(sock); // Reschedule cron job with new time

      const newCutoffInfo = getCutoffTimeInfo();
      await sock.sendMessage(chatId, {
        text: formatMessage(config.MESSAGES.CUTOFF_TIME_SET, {
          cutoffTime: newCutoffInfo.cutoffTime,
          currentTime: newCutoffInfo.currentTime,
          status: newCutoffInfo.isBookingAllowed
            ? "🟢 الحجوزات مفتوحة حالياً"
            : "🔴 الحجوزات ستُغلق عند هذا الوقت",
        }),
      });

      console.log(`⏰ Admin set cutoff time to ${formatTime(hour, minute)}`);
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // Analytics & Reports Commands - أوامر التقارير والإحصائيات
    // ═══════════════════════════════════════════════════════════

    // Analytics Command - إحصائيات العيادة
    if (
      textLower === "!احصائيات" ||
      textLower === "!analytics" ||
      textLower === "!stats"
    ) {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const analytics = db.getAnalytics();
      const analyticsMessage = formatMessage(config.MESSAGES.ADMIN_ANALYTICS, {
        todayBookings: analytics.todayBookings,
        todayRevenue: analytics.todayRevenue,
        totalBookings: analytics.totalBookings,
        pendingPayments: analytics.pendingPaymentsCount,
        newVisits: analytics.newVisits,
        followupVisits: analytics.followupVisits,
        totalRevenue: analytics.totalRevenue,
        currency: config.PRICES.CURRENCY,
      });

      await sock.sendMessage(chatId, { text: analyticsMessage });
      console.log(`📊 Admin viewed analytics`);
      return;
    }

    // Doctor's Patients Command - مرضى دكتور معين
    if (text.startsWith("!مرضى_دكتور") || text.startsWith("!doctor_patients")) {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const doctorId = text
        .replace("!مرضى_دكتور", "")
        .replace("!doctor_patients", "")
        .trim();

      // If no doctor ID provided, show list of doctors
      if (!doctorId) {
        const doctors = db.getAllDoctors();
        if (doctors.length === 0) {
          await sock.sendMessage(chatId, {
            text: config.MESSAGES.DOCTORS_LIST_EMPTY,
          });
          return;
        }

        let doctorsList = "";
        doctors.forEach((doc, index) => {
          doctorsList += `*${index + 1}.* ${doc.name} (🆔 ${doc.id})\n`;
        });

        await sock.sendMessage(chatId, {
          text: formatMessage(
            config.MESSAGES.ADMIN_SELECT_DOCTOR_FOR_PATIENTS,
            { doctorsList }
          ),
        });
        return;
      }

      const doctor = db.getDoctorById(doctorId);
      if (!doctor) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.DOCTOR_NOT_FOUND,
        });
        return;
      }

      const patients = db.getPatientsForDoctor(doctorId);

      if (patients.length === 0) {
        await sock.sendMessage(chatId, {
          text: formatMessage(config.MESSAGES.ADMIN_DOCTOR_PATIENTS_EMPTY, {
            doctorName: doctor.name,
          }),
        });
        return;
      }

      // Calculate stats
      const newVisits = patients.filter((p) => p.visitType === "new").length;
      const followupVisits = patients.filter(
        (p) => p.visitType === "followup"
      ).length;
      const totalRevenue = patients.reduce((sum, p) => sum + (p.price || 0), 0);

      let msg =
        formatMessage(config.MESSAGES.ADMIN_DOCTOR_PATIENTS_HEADER, {
          doctorName: doctor.name,
          totalPatients: patients.length,
          newVisits,
          followupVisits,
          totalRevenue,
          currency: config.PRICES.CURRENCY,
        }) + "\n\n";

      patients.forEach((patient, index) => {
        msg +=
          formatMessage(config.MESSAGES.ADMIN_DOCTOR_PATIENTS_ITEM, {
            index: index + 1,
            patientName: patient.patientName,
            bookingId: patient.id,
            visitType: getVisitTypeLabel(patient.visitType),
            queuePosition: patient.queuePosition,
            price: patient.price,
            currency: config.PRICES.CURRENCY,
            date: new Date(
              patient.confirmedAt || patient.createdAt
            ).toLocaleString("ar-SA"),
          }) + "\n\n";
      });

      msg += formatMessage(config.MESSAGES.ADMIN_DOCTOR_PATIENTS_FOOTER, {
        count: patients.length,
      });

      await sock.sendMessage(chatId, { text: msg });
      console.log(`📋 Admin viewed patients for Dr. ${doctor.name}`);
      return;
    }

    // Today's Bookings Command - حجوزات اليوم
    if (
      textLower === "!حجوزات_اليوم" ||
      textLower === "!today" ||
      textLower === "!today_bookings"
    ) {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const todayBookings = db.getTodayBookings();

      if (todayBookings.length === 0) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.ADMIN_TODAY_BOOKINGS_EMPTY,
        });
        return;
      }

      const totalRevenue = todayBookings.reduce(
        (sum, b) => sum + (b.price || 0),
        0
      );

      let msg =
        formatMessage(config.MESSAGES.ADMIN_TODAY_BOOKINGS_HEADER, {
          totalBookings: todayBookings.length,
          totalRevenue,
          currency: config.PRICES.CURRENCY,
        }) + "\n\n";

      todayBookings.forEach((booking, index) => {
        msg +=
          formatMessage(config.MESSAGES.ADMIN_TODAY_BOOKINGS_ITEM, {
            index: index + 1,
            patientName: booking.patientName,
            doctorName: booking.doctorName,
            visitType: getVisitTypeLabel(booking.visitType),
            queuePosition: booking.queuePosition,
            price: booking.price,
            currency: config.PRICES.CURRENCY,
          }) + "\n\n";
      });

      msg += config.MESSAGES.ADMIN_TODAY_BOOKINGS_FOOTER;

      await sock.sendMessage(chatId, { text: msg });
      console.log(`📅 Admin viewed today's bookings`);
      return;
    }

    // All Bookings Command - جميع الحجوزات
    if (
      textLower === "!كل_الحجوزات" ||
      textLower === "!all_bookings" ||
      textLower === "!الحجوزات"
    ) {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const allBookings = db.getAllConfirmedBookings();

      if (allBookings.length === 0) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.ADMIN_ALL_BOOKINGS_EMPTY,
        });
        return;
      }

      const totalRevenue = allBookings.reduce(
        (sum, b) => sum + (b.price || 0),
        0
      );

      let msg = config.MESSAGES.ADMIN_ALL_BOOKINGS_HEADER + "\n\n";

      // Show last 20 bookings to avoid message being too long
      const recentBookings = allBookings.slice(-20).reverse();

      recentBookings.forEach((booking, index) => {
        msg +=
          formatMessage(config.MESSAGES.ADMIN_ALL_BOOKINGS_ITEM, {
            index: index + 1,
            patientName: booking.patientName,
            bookingId: booking.id,
            doctorName: booking.doctorName,
            visitType: getVisitTypeLabel(booking.visitType),
            queuePosition: booking.queuePosition,
            price: booking.price,
            currency: config.PRICES.CURRENCY,
            date: new Date(
              booking.confirmedAt || booking.createdAt
            ).toLocaleString("ar-SA"),
          }) + "\n\n";
      });

      msg += formatMessage(config.MESSAGES.ADMIN_ALL_BOOKINGS_FOOTER, {
        count: allBookings.length,
        totalRevenue,
        currency: config.PRICES.CURRENCY,
      });

      if (allBookings.length > 20) {
        msg += `\n\n📝 _عرض آخر 20 حجز من أصل ${allBookings.length}_`;
      }

      await sock.sendMessage(chatId, { text: msg });
      console.log(`📋 Admin viewed all bookings`);
      return;
    }

    // Doctor Stats Command - إحصائيات الدكاترة
    if (textLower === "!احصائيات_الدكاترة" || textLower === "!doctor_stats") {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.NOT_ADMIN });
        return;
      }

      const analytics = db.getAnalytics();

      if (analytics.doctorStats.length === 0) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.ADMIN_DOCTOR_STATS_EMPTY,
        });
        return;
      }

      let msg = config.MESSAGES.ADMIN_DOCTOR_STATS_HEADER + "\n\n";

      analytics.doctorStats.forEach((stat, index) => {
        msg +=
          formatMessage(config.MESSAGES.ADMIN_DOCTOR_STATS_ITEM, {
            index: index + 1,
            doctorName: stat.doctorName,
            totalBookings: stat.totalBookings,
            newVisits: stat.newVisits,
            followupVisits: stat.followupVisits,
            totalRevenue: stat.totalRevenue,
            currency: config.PRICES.CURRENCY,
          }) + "\n\n";
      });

      msg += config.MESSAGES.ADMIN_DOCTOR_STATS_FOOTER;

      await sock.sendMessage(chatId, { text: msg });
      console.log(`📊 Admin viewed doctor stats`);
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // Patient Flow - نظام المرضى
    // ═══════════════════════════════════════════════════════════

    // New booking command - إنشاء حجز جديد (يتجاوز الحجز النشط)
    if (
      textLower === "!حجز_جديد" ||
      textLower === "!new_booking" ||
      textLower === "حجز جديد" ||
      textLower === "حجزجديد" ||
      textLower === "new booking"
    ) {
      // Check if booking is allowed (cutoff time)
      if (!isBookingAllowed()) {
        const cutoffInfo = getCutoffTimeInfo();
        await sock.sendMessage(chatId, {
          text: formatMessage(config.MESSAGES.BOOKING_CLOSED, {
            cutoffTime: cutoffInfo.cutoffTime,
            currentTime: cutoffInfo.currentTime,
          }),
        });
        return;
      }

      const doctors = db.getAllDoctors();

      // Clear notification tracking for this user
      notifiedActiveBookings.delete(chatId);

      resetSession(chatId);
      updateSession(chatId, { state: SESSION_STATES.AWAITING_DOCTOR_CHOICE });

      await sock.sendMessage(chatId, {
        text: generatePatientWelcome(doctors, senderName),
      });
      return;
    }

    // Check if patient has an active booking (pending or submitted)
    // Skip this check for admins and for specific commands
    const isCommand =
      text.startsWith("!") ||
      [
        "دكاترة",
        "قائمة",
        "مساعدة",
        "حجز جديد",
        "تحديث بياناتي",
        "ping",
      ].includes(textLower);
    const activeBooking = db.getActiveBookingByChatId(chatId);

    if (activeBooking && !adminStatus && !isCommand) {
      // Check if we already notified this patient
      if (!notifiedActiveBookings.has(chatId)) {
        // First time - notify them about their active booking
        notifiedActiveBookings.add(chatId);

        const visitTypeLabel =
          activeBooking.visitType === "new" ? "كشف جديد" : "متابعة";

        let activeBookingMessage;
        if (activeBooking.status === "awaiting_payment") {
          activeBookingMessage = formatMessage(
            config.MESSAGES.ACTIVE_BOOKING_AWAITING_PAYMENT,
            {
              bookingId: activeBooking.id,
              doctorName: activeBooking.doctorName,
              specialty: activeBooking.doctorSpecialty,
              patientName: activeBooking.patientName,
              patientPhone: activeBooking.patientPhone,
              visitType: visitTypeLabel,
              price: activeBooking.price,
              currency: config.PRICES.CURRENCY,
            }
          );

          // Set session state to await payment proof
          updateSession(chatId, {
            state: SESSION_STATES.AWAITING_PAYMENT_PROOF,
            bookingId: activeBooking.id,
            selectedDoctor: {
              id: activeBooking.doctorId,
              name: activeBooking.doctorName,
              specialty: activeBooking.doctorSpecialty,
            },
            patientName: activeBooking.patientName,
            patientPhone: activeBooking.patientPhone,
            visitType: activeBooking.visitType,
          });
        } else {
          // payment_submitted
          activeBookingMessage = formatMessage(
            config.MESSAGES.ACTIVE_BOOKING_PAYMENT_SUBMITTED,
            {
              bookingId: activeBooking.id,
              doctorName: activeBooking.doctorName,
              specialty: activeBooking.doctorSpecialty,
              patientName: activeBooking.patientName,
              patientPhone: activeBooking.patientPhone,
              visitType: visitTypeLabel,
              price: activeBooking.price,
              currency: config.PRICES.CURRENCY,
            }
          );

          // Set session state to payment submitted
          updateSession(chatId, {
            state: SESSION_STATES.PAYMENT_SUBMITTED,
            bookingId: activeBooking.id,
          });
        }

        await sock.sendMessage(chatId, { text: activeBookingMessage });
        console.log(
          `📋 Notified patient about active booking #${activeBooking.id}`
        );
      }
      // If already notified, ignore the message (don't respond)
      // But still handle images for payment proof
      return;
    }

    // Update patient info command - تحديث بيانات المريض
    if (
      textLower === "!تحديث_بياناتي" ||
      textLower === "!update_info" ||
      textLower === "تحديث بياناتي" ||
      textLower === "تغيير بياناتي" ||
      textLower === "update info"
    ) {
      const doctors = db.getAllDoctors();

      // Force asking for new info by not preserving old data
      resetSession(chatId);

      if (session.selectedDoctor) {
        // If they already selected a doctor, keep that and ask for name
        updateSession(chatId, {
          state: SESSION_STATES.AWAITING_PATIENT_NAME,
          selectedDoctor: session.selectedDoctor,
        });

        await sock.sendMessage(chatId, {
          text: config.MESSAGES.UPDATE_INFO_START,
        });
      } else {
        // Start fresh
        updateSession(chatId, { state: SESSION_STATES.AWAITING_DOCTOR_CHOICE });

        await sock.sendMessage(chatId, {
          text: generatePatientWelcome(doctors, senderName),
        });
      }
      return;
    }

    // Start/Restart patient flow
    if (config.START_KEYWORDS.some((kw) => textLower.includes(kw))) {
      // Check if booking is allowed (cutoff time)
      if (!isBookingAllowed()) {
        const cutoffInfo = getCutoffTimeInfo();
        await sock.sendMessage(chatId, {
          text: formatMessage(config.MESSAGES.BOOKING_CLOSED, {
            cutoffTime: cutoffInfo.cutoffTime,
            currentTime: cutoffInfo.currentTime,
          }),
        });
        return;
      }

      const doctors = db.getAllDoctors();

      // Check if returning patient
      const existingPatient = db.getPatientInfoByChatId(chatId);

      resetSession(chatId);
      updateSession(chatId, {
        state: SESSION_STATES.AWAITING_DOCTOR_CHOICE,
        patientName: existingPatient?.patientName || null,
        patientPhone: existingPatient?.patientPhone || null,
      });

      await sock.sendMessage(chatId, {
        text: generatePatientWelcome(doctors, senderName),
      });
      return;
    }

    // If session is IDLE, start the flow
    if (session.state === SESSION_STATES.IDLE) {
      // Check if booking is allowed (cutoff time)
      if (!isBookingAllowed()) {
        const cutoffInfo = getCutoffTimeInfo();
        await sock.sendMessage(chatId, {
          text: formatMessage(config.MESSAGES.BOOKING_CLOSED, {
            cutoffTime: cutoffInfo.cutoffTime,
            currentTime: cutoffInfo.currentTime,
          }),
        });
        return;
      }

      const doctors = db.getAllDoctors();

      // Check if returning patient
      const existingPatient = db.getPatientInfoByChatId(chatId);

      updateSession(chatId, {
        state: SESSION_STATES.AWAITING_DOCTOR_CHOICE,
        patientName: existingPatient?.patientName || null,
        patientPhone: existingPatient?.patientPhone || null,
      });

      await sock.sendMessage(chatId, {
        text: generatePatientWelcome(doctors, senderName),
      });
      return;
    }

    // Show doctors list command (patient-friendly - no prefix needed)
    if (
      textLower === "دكاترة" ||
      textLower === "قائمة" ||
      textLower === "!دكاترة" ||
      textLower === "!قائمة" ||
      textLower === "الدكاترة" ||
      textLower === "عرض الدكاترة" ||
      textLower === "doctors" ||
      textLower === "list"
    ) {
      // Check if booking is allowed (cutoff time)
      if (!isBookingAllowed()) {
        const cutoffInfo = getCutoffTimeInfo();
        await sock.sendMessage(chatId, {
          text: formatMessage(config.MESSAGES.BOOKING_CLOSED, {
            cutoffTime: cutoffInfo.cutoffTime,
            currentTime: cutoffInfo.currentTime,
          }),
        });
        return;
      }

      const doctors = db.getAllDoctors();

      resetSession(chatId);
      updateSession(chatId, { state: SESSION_STATES.AWAITING_DOCTOR_CHOICE });

      await sock.sendMessage(chatId, {
        text: generateShowDoctorsList(doctors),
      });
      return;
    }

    // Handle doctor selection
    if (session.state === SESSION_STATES.AWAITING_DOCTOR_CHOICE) {
      const doctors = db.getAllDoctors();

      if (doctors.length === 0) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.NO_DOCTORS_AVAILABLE,
        });
        return;
      }

      const selectedDoctor = findDoctor(text, doctors);

      if (selectedDoctor) {
        // Check if patient already has a booking with this doctor
        const existingBooking = db.getExistingBookingWithDoctor(
          chatId,
          selectedDoctor.id
        );

        if (existingBooking) {
          const visitTypeLabel =
            existingBooking.visitType === "new" ? "كشف جديد" : "متابعة";

          // Check if it's a confirmed booking or pending
          if (existingBooking.status === "confirmed") {
            await sock.sendMessage(chatId, {
              text: formatMessage(config.MESSAGES.ALREADY_BOOKED_WITH_DOCTOR, {
                bookingId: existingBooking.id,
                doctorName: existingBooking.doctorName,
                specialty: existingBooking.doctorSpecialty,
                patientName: existingBooking.patientName,
                patientPhone: existingBooking.patientPhone,
                visitType: visitTypeLabel,
                queuePosition: existingBooking.queuePosition,
                bookingDate: new Date(
                  existingBooking.confirmedAt || existingBooking.createdAt
                ).toLocaleString("ar-SA"),
                status: "✅ مأكد",
              }),
            });
          } else {
            // Pending payment
            const statusText =
              existingBooking.status === "awaiting_payment"
                ? "⏳ بانتظار إرسال إثبات الدفع"
                : "⏳ جاري مراجعة الدفع";
            const instructions =
              existingBooking.status === "awaiting_payment"
                ? "📸 أرسل صورة إيصال الدفع لإتمام الحجز"
                : "انتظر تأكيد الإدارة للدفع";

            await sock.sendMessage(chatId, {
              text: formatMessage(config.MESSAGES.ALREADY_PENDING_WITH_DOCTOR, {
                bookingId: existingBooking.id,
                doctorName: existingBooking.doctorName,
                specialty: existingBooking.doctorSpecialty,
                patientName: existingBooking.patientName,
                patientPhone: existingBooking.patientPhone,
                visitType: visitTypeLabel,
                price: existingBooking.price,
                currency: config.PRICES.CURRENCY,
                status: statusText,
                instructions: instructions,
              }),
            });

            // Set session state for payment if awaiting
            if (existingBooking.status === "awaiting_payment") {
              updateSession(chatId, {
                state: SESSION_STATES.AWAITING_PAYMENT_PROOF,
                bookingId: existingBooking.id,
                selectedDoctor: selectedDoctor,
                patientName: existingBooking.patientName,
                patientPhone: existingBooking.patientPhone,
                visitType: existingBooking.visitType,
              });
            }
          }

          console.log(
            `📋 Patient already has booking #${existingBooking.id} with Dr. ${selectedDoctor.name}`
          );
          return;
        }

        // Check if we have existing patient info (for new booking with different doctor)
        const existingPatient = db.getPatientInfoByChatId(chatId);

        if (
          existingPatient &&
          existingPatient.patientName &&
          existingPatient.patientPhone
        ) {
          // Skip name and phone, go directly to visit type
          updateSession(chatId, {
            state: SESSION_STATES.AWAITING_VISIT_TYPE,
            selectedDoctor: selectedDoctor,
            patientName: existingPatient.patientName,
            patientPhone: existingPatient.patientPhone,
          });

          await sock.sendMessage(chatId, {
            text: formatMessage(config.MESSAGES.WELCOME_BACK_PATIENT, {
              patientName: existingPatient.patientName,
              patientPhone: existingPatient.patientPhone,
              doctorName: selectedDoctor.name,
              specialty: selectedDoctor.specialty,
            }),
          });

          console.log(
            `👤 Returning patient ${existingPatient.patientName} selected Dr. ${selectedDoctor.name}`
          );
          return;
        }

        // New patient - ask for name
        updateSession(chatId, {
          state: SESSION_STATES.AWAITING_PATIENT_NAME,
          selectedDoctor: selectedDoctor,
        });

        await sock.sendMessage(chatId, {
          text: generateDoctorSelected(selectedDoctor),
        });

        console.log(
          `👤 Patient ${senderName} selected Dr. ${selectedDoctor.name}`
        );
        return;
      } else {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.INVALID_DOCTOR_CHOICE,
        });
        return;
      }
    }

    // Handle patient name input
    if (session.state === SESSION_STATES.AWAITING_PATIENT_NAME) {
      const patientName = text.trim();

      if (patientName.length < 3) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.INVALID_PATIENT_NAME,
        });
        return;
      }

      updateSession(chatId, {
        state: SESSION_STATES.AWAITING_PATIENT_PHONE,
        patientName: patientName,
      });

      await sock.sendMessage(chatId, {
        text: config.MESSAGES.ASK_PATIENT_PHONE,
      });

      console.log(`📝 Patient name entered: ${patientName}`);
      return;
    }

    // Handle patient phone input
    if (session.state === SESSION_STATES.AWAITING_PATIENT_PHONE) {
      let patientPhone = text.trim();

      // Remove any spaces, dashes, or special characters
      patientPhone = patientPhone.replace(/[\s\-\(\)\.]/g, "");

      // Convert Arabic numerals to Western
      patientPhone = convertArabicToWesternNumerals(patientPhone);

      // Remove leading + if present
      if (patientPhone.startsWith("+")) {
        patientPhone = patientPhone.slice(1);
      }

      // Validate phone number (any international format: minimum 7 digits, maximum 15 digits)
      const phoneRegex = /^\d{7,15}$/;

      if (!phoneRegex.test(patientPhone)) {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.INVALID_PATIENT_PHONE,
        });
        return;
      }

      updateSession(chatId, {
        state: SESSION_STATES.AWAITING_VISIT_TYPE,
        patientPhone: patientPhone,
      });

      await sock.sendMessage(chatId, {
        text: generateAskVisitType(session.patientName),
      });

      console.log(`📱 Patient phone entered: ${patientPhone}`);
      return;
    }

    // Handle visit type selection
    if (session.state === SESSION_STATES.AWAITING_VISIT_TYPE) {
      const input = convertArabicToWesternNumerals(text.trim().toLowerCase());

      let visitType = null;

      if (config.VISIT_TYPES.NEW.keywords.includes(input)) {
        visitType = VISIT_TYPES.NEW;
      } else if (config.VISIT_TYPES.FOLLOWUP.keywords.includes(input)) {
        visitType = VISIT_TYPES.FOLLOWUP;
      }

      if (visitType) {
        updateSession(chatId, {
          state: SESSION_STATES.AWAITING_CONFIRMATION,
          visitType: visitType,
        });

        const updatedSession = getSession(chatId);
        await sock.sendMessage(chatId, {
          text: generateConfirmBooking(updatedSession),
        });

        console.log(`📋 Visit type selected: ${visitType}`);
        return;
      } else {
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.INVALID_VISIT_TYPE,
        });
        return;
      }
    }

    // Handle confirmation
    if (session.state === SESSION_STATES.AWAITING_CONFIRMATION) {
      const input = convertArabicToWesternNumerals(text.trim().toLowerCase());

      // Confirm booking - proceed to payment
      if (config.CONFIRMATION.YES.includes(input)) {
        const price = getPrice(session.visitType);
        const pendingPayment = db.addPendingPayment({
          chatId: chatId,
          patientName: session.patientName,
          patientPhone: session.patientPhone,
          doctorId: session.selectedDoctor.id,
          doctorName: session.selectedDoctor.name,
          doctorSpecialty: session.selectedDoctor.specialty,
          visitType: session.visitType,
          price: price,
        });

        updateSession(chatId, {
          state: SESSION_STATES.AWAITING_PAYMENT_PROOF,
          bookingId: pendingPayment.id,
        });

        await sock.sendMessage(chatId, {
          text: generatePaymentMessage(session, pendingPayment.id),
        });

        // Send payment number separately for easy copying
        if (config.PAYMENT_METHODS.SYRIATEL_CASH?.enabled) {
          await sock.sendMessage(chatId, {
            text: `${config.PAYMENT_METHODS.SYRIATEL_CASH.number}`,
          });
        }
        if (config.PAYMENT_METHODS.BANK_TRANSFER?.enabled) {
          await sock.sendMessage(chatId, {
            text: `${config.PAYMENT_METHODS.BANK_TRANSFER.iban}`,
          });
        }

        console.log(`💳 Payment requested for booking #${pendingPayment.id}`);
        return;
      }

      // Cancel booking
      if (config.CONFIRMATION.NO.includes(input)) {
        resetSession(chatId);

        await sock.sendMessage(chatId, {
          text: config.MESSAGES.BOOKING_CANCELLED,
        });

        console.log(`❌ Booking cancelled by patient`);
        return;
      }

      // Edit booking
      if (config.CONFIRMATION.EDIT.includes(input)) {
        await sock.sendMessage(chatId, { text: config.MESSAGES.EDIT_OPTIONS });
        return;
      }

      // Handle edit sub-options
      if (input === "رجوع" || input === "back") {
        await sock.sendMessage(chatId, {
          text: generateConfirmBooking(session),
        });
        return;
      }

      // Invalid confirmation input
      await sock.sendMessage(chatId, {
        text: config.MESSAGES.INVALID_CONFIRMATION,
      });
      return;
    }

    // Handle payment proof state
    if (session.state === SESSION_STATES.AWAITING_PAYMENT_PROOF) {
      const input = convertArabicToWesternNumerals(text.trim().toLowerCase());

      if (input === "إلغاء" || input === "الغاء" || input === "cancel") {
        resetSession(chatId);
        await sock.sendMessage(chatId, {
          text: config.MESSAGES.BOOKING_CANCELLED,
        });
        return;
      }

      await sock.sendMessage(chatId, {
        text: formatMessage(config.MESSAGES.PAYMENT_REMINDER, {
          bookingId: session.bookingId,
        }),
      });
      return;
    }

    // Handle payment submitted state
    if (session.state === SESSION_STATES.PAYMENT_SUBMITTED) {
      await sock.sendMessage(chatId, {
        text: formatMessage(config.MESSAGES.PAYMENT_PENDING_STATUS, {
          bookingId: session.bookingId,
        }),
      });
      return;
    }

    // Handle confirmed state
    if (session.state === SESSION_STATES.BOOKING_CONFIRMED) {
      resetSession(chatId);
      const doctors = db.getAllDoctors();

      updateSession(chatId, { state: SESSION_STATES.AWAITING_DOCTOR_CHOICE });

      await sock.sendMessage(chatId, {
        text: generatePatientWelcome(doctors, senderName),
      });
      return;
    }
  });
}

// Start the bot
console.log("═".repeat(50));
console.log(`🏥 ${config.BOT_NAME} - ${config.CLINIC_NAME}`);
console.log("═".repeat(50));
console.log("📱 Starting WhatsApp connection...");
startBot();

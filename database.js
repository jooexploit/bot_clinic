const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "doctors.json");
const BOOKINGS_PATH = path.join(__dirname, "bookings.json");

// Load doctors from file
function loadDoctors() {
  try {
    const data = fs.readFileSync(DB_PATH, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return { doctors: [], nextId: 1 };
  }
}

// Save doctors to file
function saveDoctors(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 4), "utf8");
}

// Load bookings from file
function loadBookings() {
  try {
    const data = fs.readFileSync(BOOKINGS_PATH, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return { bookings: [], pendingPayments: [], nextBookingId: 1 };
  }
}

// Save bookings to file
function saveBookings(data) {
  fs.writeFileSync(BOOKINGS_PATH, JSON.stringify(data, null, 4), "utf8");
}

// Add a new doctor
function addDoctor(name, specialty, whatsapp) {
  const data = loadDoctors();
  const newDoctor = {
    id: data.nextId,
    name: name,
    specialty: specialty,
    whatsapp: whatsapp,
    createdAt: new Date().toISOString(),
  };
  data.doctors.push(newDoctor);
  data.nextId++;
  saveDoctors(data);
  return newDoctor;
}

// Remove doctor by ID
function removeDoctorById(id) {
  const data = loadDoctors();
  const index = data.doctors.findIndex((d) => d.id === parseInt(id));
  if (index === -1) return null;
  const removed = data.doctors.splice(index, 1)[0];
  saveDoctors(data);
  return removed;
}

// Remove doctor by name
function removeDoctorByName(name) {
  const data = loadDoctors();
  const index = data.doctors.findIndex((d) =>
    d.name.toLowerCase().includes(name.toLowerCase())
  );
  if (index === -1) return null;
  const removed = data.doctors.splice(index, 1)[0];
  saveDoctors(data);
  return removed;
}

// Get all doctors
function getAllDoctors() {
  const data = loadDoctors();
  return data.doctors;
}

// Get doctor by ID
function getDoctorById(id) {
  const data = loadDoctors();
  return data.doctors.find((d) => d.id === parseInt(id));
}

// ═══════════════════════════════════════════════════════════
// Booking Functions - وظائف الحجوزات
// ═══════════════════════════════════════════════════════════

// Add pending payment (waiting for payment proof)
function addPendingPayment(bookingData) {
  const data = loadBookings();
  const pending = {
    id: data.nextBookingId,
    chatId: bookingData.chatId,
    patientName: bookingData.patientName,
    patientPhone: bookingData.patientPhone,
    doctorId: bookingData.doctorId,
    doctorName: bookingData.doctorName,
    doctorSpecialty: bookingData.doctorSpecialty,
    visitType: bookingData.visitType,
    price: bookingData.price,
    status: "awaiting_payment", // awaiting_payment, payment_submitted, confirmed, rejected
    paymentProof: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.pendingPayments.push(pending);
  data.nextBookingId++;
  saveBookings(data);
  return pending;
}

// Update pending payment with proof
function submitPaymentProof(bookingId, proofImageId) {
  const data = loadBookings();
  const pending = data.pendingPayments.find(
    (p) => p.id === parseInt(bookingId)
  );
  if (!pending) return null;

  pending.paymentProof = proofImageId;
  pending.status = "payment_submitted";
  pending.updatedAt = new Date().toISOString();
  saveBookings(data);
  return pending;
}

// Get pending payment by ID
function getPendingPaymentById(id) {
  const data = loadBookings();
  return data.pendingPayments.find((p) => p.id === parseInt(id));
}

// Get pending payment by chat ID
function getPendingPaymentByChatId(chatId) {
  const data = loadBookings();
  return data.pendingPayments.find(
    (p) =>
      p.chatId === chatId &&
      (p.status === "awaiting_payment" || p.status === "payment_submitted")
  );
}

// Confirm booking (admin confirms payment)
function confirmBooking(bookingId) {
  const data = loadBookings();
  const pendingIndex = data.pendingPayments.findIndex(
    (p) => p.id === parseInt(bookingId)
  );

  if (pendingIndex === -1) return null;

  const pending = data.pendingPayments[pendingIndex];

  // Get queue position for this doctor
  const doctorBookings = data.bookings.filter(
    (b) => b.doctorId === pending.doctorId && b.status === "confirmed"
  );
  const queuePosition = doctorBookings.length + 1;

  // Create confirmed booking
  const confirmedBooking = {
    ...pending,
    status: "confirmed",
    queuePosition: queuePosition,
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Move from pending to bookings
  data.pendingPayments.splice(pendingIndex, 1);
  data.bookings.push(confirmedBooking);
  saveBookings(data);

  return confirmedBooking;
}

// Reject booking (admin rejects payment)
function rejectBooking(bookingId, reason = "") {
  const data = loadBookings();
  const pendingIndex = data.pendingPayments.findIndex(
    (p) => p.id === parseInt(bookingId)
  );

  if (pendingIndex === -1) return null;

  const pending = data.pendingPayments[pendingIndex];
  pending.status = "rejected";
  pending.rejectionReason = reason;
  pending.updatedAt = new Date().toISOString();

  // Remove from pending
  data.pendingPayments.splice(pendingIndex, 1);
  saveBookings(data);

  return pending;
}

// Get all pending payments (for admin)
function getAllPendingPayments() {
  const data = loadBookings();
  return data.pendingPayments.filter((p) => p.status === "payment_submitted");
}

// Get confirmed bookings for a doctor
function getConfirmedBookingsForDoctor(doctorId) {
  const data = loadBookings();
  return data.bookings.filter(
    (b) => b.doctorId === parseInt(doctorId) && b.status === "confirmed"
  );
}

// Get all confirmed bookings
function getAllConfirmedBookings() {
  const data = loadBookings();
  return data.bookings.filter((b) => b.status === "confirmed");
}

// Get patients for a specific doctor
function getPatientsForDoctor(doctorId) {
  const data = loadBookings();
  return data.bookings.filter(
    (b) => b.doctorId === parseInt(doctorId) && b.status === "confirmed"
  );
}

// Get today's bookings
function getTodayBookings() {
  const data = loadBookings();
  const today = new Date().toISOString().split("T")[0];
  return data.bookings.filter((b) => {
    const bookingDate = new Date(b.confirmedAt || b.createdAt)
      .toISOString()
      .split("T")[0];
    return bookingDate === today && b.status === "confirmed";
  });
}

// Get bookings by date range
function getBookingsByDateRange(startDate, endDate) {
  const data = loadBookings();
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  return data.bookings.filter((b) => {
    const bookingDate = new Date(b.confirmedAt || b.createdAt);
    return (
      bookingDate >= start && bookingDate <= end && b.status === "confirmed"
    );
  });
}

// Get analytics summary
function getAnalytics() {
  const data = loadBookings();
  const confirmedBookings = data.bookings.filter(
    (b) => b.status === "confirmed"
  );
  const pendingPayments = data.pendingPayments;

  // Today's stats
  const today = new Date().toISOString().split("T")[0];
  const todayBookings = confirmedBookings.filter((b) => {
    const bookingDate = new Date(b.confirmedAt || b.createdAt)
      .toISOString()
      .split("T")[0];
    return bookingDate === today;
  });

  // Calculate revenue
  const totalRevenue = confirmedBookings.reduce(
    (sum, b) => sum + (b.price || 0),
    0
  );
  const todayRevenue = todayBookings.reduce(
    (sum, b) => sum + (b.price || 0),
    0
  );

  // Count by visit type
  const newVisits = confirmedBookings.filter(
    (b) => b.visitType === "new"
  ).length;
  const followupVisits = confirmedBookings.filter(
    (b) => b.visitType === "followup"
  ).length;

  // Count by doctor
  const doctorStats = {};
  confirmedBookings.forEach((b) => {
    if (!doctorStats[b.doctorId]) {
      doctorStats[b.doctorId] = {
        doctorId: b.doctorId,
        doctorName: b.doctorName,
        totalBookings: 0,
        totalRevenue: 0,
        newVisits: 0,
        followupVisits: 0,
      };
    }
    doctorStats[b.doctorId].totalBookings++;
    doctorStats[b.doctorId].totalRevenue += b.price || 0;
    if (b.visitType === "new") {
      doctorStats[b.doctorId].newVisits++;
    } else {
      doctorStats[b.doctorId].followupVisits++;
    }
  });

  return {
    totalBookings: confirmedBookings.length,
    pendingPaymentsCount: pendingPayments.length,
    todayBookings: todayBookings.length,
    totalRevenue,
    todayRevenue,
    newVisits,
    followupVisits,
    doctorStats: Object.values(doctorStats),
  };
}

// Get all pending payments (including awaiting_payment status)
function getAllPendingPaymentsAll() {
  const data = loadBookings();
  return data.pendingPayments;
}

// Get patient info by chat ID (from previous bookings)
function getPatientInfoByChatId(chatId) {
  const data = loadBookings();

  // First check confirmed bookings (most recent first)
  const confirmedBooking = data.bookings
    .filter((b) => b.chatId === chatId)
    .sort(
      (a, b) =>
        new Date(b.confirmedAt || b.createdAt) -
        new Date(a.confirmedAt || a.createdAt)
    )[0];

  if (confirmedBooking) {
    return {
      patientName: confirmedBooking.patientName,
      patientPhone: confirmedBooking.patientPhone,
    };
  }

  // Then check pending payments
  const pendingPayment = data.pendingPayments
    .filter((p) => p.chatId === chatId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  if (pendingPayment) {
    return {
      patientName: pendingPayment.patientName,
      patientPhone: pendingPayment.patientPhone,
    };
  }

  return null;
}

// Get active booking by chat ID (pending or submitted payment)
function getActiveBookingByChatId(chatId) {
  const data = loadBookings();

  // Find active booking (awaiting_payment or payment_submitted)
  const activeBooking = data.pendingPayments.find(
    (p) =>
      p.chatId === chatId &&
      (p.status === "awaiting_payment" || p.status === "payment_submitted")
  );

  return activeBooking || null;
}

// Get existing confirmed booking for a patient with a specific doctor
function getExistingBookingWithDoctor(chatId, doctorId) {
  const data = loadBookings();

  // Check confirmed bookings
  const confirmedBooking = data.bookings.find(
    (b) =>
      b.chatId === chatId &&
      b.doctorId === parseInt(doctorId) &&
      b.status === "confirmed"
  );

  if (confirmedBooking) return confirmedBooking;

  // Check pending payments too
  const pendingBooking = data.pendingPayments.find(
    (p) =>
      p.chatId === chatId &&
      p.doctorId === parseInt(doctorId) &&
      (p.status === "awaiting_payment" || p.status === "payment_submitted")
  );

  return pendingBooking || null;
}

// Clear all bookings (daily cleanup)
function clearAllBookings() {
  const data = loadBookings();

  // Store counts for logging
  const clearedCounts = {
    confirmedBookings: data.bookings.length,
    pendingPayments: data.pendingPayments.length,
  };

  // Reset all bookings but keep the nextBookingId incrementing
  data.bookings = [];
  data.pendingPayments = [];
  // Don't reset nextBookingId to maintain unique IDs

  saveBookings(data);

  return clearedCounts;
}

module.exports = {
  addDoctor,
  removeDoctorById,
  removeDoctorByName,
  getAllDoctors,
  getDoctorById,
  // Booking functions
  addPendingPayment,
  submitPaymentProof,
  getPendingPaymentById,
  getPendingPaymentByChatId,
  confirmBooking,
  rejectBooking,
  getAllPendingPayments,
  getAllPendingPaymentsAll,
  getConfirmedBookingsForDoctor,
  getAllConfirmedBookings,
  getPatientsForDoctor,
  getTodayBookings,
  getBookingsByDateRange,
  getAnalytics,
  getPatientInfoByChatId,
  getActiveBookingByChatId,
  getExistingBookingWithDoctor,
  clearAllBookings,
};

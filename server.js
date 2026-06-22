const express = require('express');
const mongoose = require('mongoose');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// 1. KONEKSI DATABASE (MONGODB ATLAS)
// Jika di hosting, gunakan baris rahasia (Environment Variable), jika lokal gunakan database cadangan
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/gereja_booking";
mongoose.connect(MONGO_URI)
    .then(() => console.log("Puji Tuhan, Database MongoDB Berhasil Terhubung!"))
    .catch(err => console.error("Gagal koneksi database:", err));

// 2. MEMBUAT STRUKTUR (SCHEMA) DATABASE DI CLOUD
const BookingSchema = new mongoose.Schema({
    nama: String,
    nomorHp: String,
    acara: String,
    tempat: String,
    tanggal: String,
    jamMulai: String,
    jamSelesai: String
});
const Booking = mongoose.model('Booking', BookingSchema);

const RoomSchema = new mongoose.Schema({ nama: String });
const Room = mongoose.model('Room', RoomSchema);

// Variabel Akun Admin
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; 
let currentSessionToken = null;

// Middleware Proteksi
function proteksiAdmin(req, res, next) {
    const tokenMasuk = req.headers['x-admin-token'];
    if (!currentSessionToken || tokenMasuk !== currentSessionToken) {
        return res.status(401).json({ success: false, message: "Akses Ditolak!" });
    }
    next();
}

// --- AUTO-DELETE JADWAL EXPIRED BERDASARKAN WAKTU WIB (ASIA/JAKARTA) ---
setInterval(async () => {
    try {
        // 1. Ambil waktu saat ini yang disesuaikan persis ke Zona Waktu WIB (Magelang)
        const waktuWIB = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
        
        // 2. Ubah menjadi format tanggal lokal (YYYY-MM-DD)
        const tahun = waktuWIB.getFullYear();
        const bulan = String(waktuWIB.getMonth() + 1).padStart(2, '0');
        const hari = String(waktuWIB.getDate()).padStart(2, '0');
        const tglSekarangWIB = `${tahun}-${bulan}-${hari}`; 

        // 3. Ubah menjadi format jam lokal (HH:MM)
        const jamSekarangWIB = waktuWIB.toTimeString().substring(0, 5); 

        // LOGIKA A: Hapus semua pesanan yang tanggalnya sudah hari-hari kemarin
        const hapusTanggalLewat = await Booking.deleteMany({ 
            tanggal: { $lt: tglSekarangWIB } 
        });

        // LOGIKA B: Hapus pesanan yang tanggalnya HARI INI, tapi JAM SELESAInya sudah lewat
        const hapusJamLewat = await Booking.deleteMany({ 
            tanggal: tglSekarangWIB, 
            jamSelesai: { $lte: jamSekarangWIB } 
        });

        // Catat ke logs server jika ada data yang dibersihkan (opsional untuk pemantauan admin)
        if (hapusTanggalLewat.deletedCount > 0 || hapusJamLewat.deletedCount > 0) {
            console.log(`[AUTO-CLEAN] Berhasil menghapus ${hapusTanggalLewat.deletedCount + hapusJamLewat.deletedCount} jadwal kedaluwarsa.`);
        }

    } catch (err) {
        console.error("Gagal menjalankan sistem auto-delete otomatis:", err);
    }
}, 60000);

// --- OTENTIKASI ADMIN ---
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        currentSessionToken = "TOKEN-" + Math.random().toString(36).substring(2);
        return res.json({ success: true, token: currentSessionToken });
    }
    res.status(401).json({ success: false, message: "Password salah!" });
});

app.post('/api/admin/change-password', proteksiAdmin, (req, res) => {
    ADMIN_PASSWORD = req.body.passwordBaru;
    currentSessionToken = null; 
    res.json({ success: true, message: "Password Berhasil Diubah! Silakan login ulang." });
});

// --- KELOLA TEMPAT (DI AMBIL DARI DATABASE) ---
app.get('/api/rooms', async (req, res) => {
    let dataRooms = await Room.find();
    // Jika database kosong, isi data awal otomatis
    if(dataRooms.length === 0) {
        await Room.insertMany([{nama: "Gedung Utama Gereja"}, {nama: "Aula Paroki"}, {nama: "Ruang Rapat"}]);
        dataRooms = await Room.find();
    }
    res.json(dataRooms.map(r => r.nama));
});

app.post('/api/rooms', proteksiAdmin, async (req, res) => {
    const { namaTempat } = req.body;
    const ada = await Room.findOne({ nama: namaTempat });
    if (ada) return res.status(400).json({ message: "Tempat sudah ada!" });
    
    await new Room({ nama: namaTempat }).save();
    res.json({ success: true, message: "Tempat ditambahkan!" });
});

app.put('/api/rooms', proteksiAdmin, async (req, res) => {
    const { namaLama, namaBaru } = req.body;
    await Room.updateOne({ nama: namaLama }, { nama: namaBaru });
    await Booking.updateMany({ tempat: namaLama }, { tempat: namaBaru });
    res.json({ success: true, message: "Tempat diubah!" });
});

app.delete('/api/rooms', proteksiAdmin, async (req, res) => {
    const { namaTempat } = req.body;
    await Room.deleteOne({ nama: namaTempat });
    await Booking.deleteMany({ tempat: namaTempat });
    res.json({ success: true, message: "Tempat dihapus!" });
});

// --- KELOLA PESANAN (BOOKINGS) ---
app.get('/api/bookings', async (req, res) => {
    let semuaJadwal = await Booking.find();
    let sorted = semuaJadwal.sort((a, b) => {
        if (a.tempat !== b.tempat) return a.tempat.localeCompare(b.tempat);
        return a.tanggal.localeCompare(b.tanggal);
    });
    res.json(sorted);
});

app.post('/api/bookings', async (req, res) => {
    const { nama, nomorHp, tempat, tanggal, jamMulai, jamSelesai, acara } = req.body;
    
    // Cek bentrok di database cloud
    const bookingBentrok = await Booking.findOne({
        tempat: tempat,
        tanggal: tanggal,
        $or: [
            { jamMulai: { $gte: jamMulai, $lt: jamSelesai } },
            { jamSelesai: { $gt: jamMulai, $lte: jamSelesai } },
            { jamMulai: { $lte: jamMulai }, jamSelesai: { $gte: jamSelesai } }
        ]
    });

    if (bookingBentrok) return res.status(400).json({ message: "Maaf, tempat sudah terpakai di jam tersebut!" });

    const baru = new Booking({ nama, nomorHp, tempat, tanggal, jamMulai, jamSelesai, acara });
    await baru.save();
    res.json({ success: true, message: "Pemesanan berhasil disimpan ke Database Cloud!" });
});

app.put('/api/bookings/:id', proteksiAdmin, async (req, res) => {
    const { id } = req.params;
    const { nama, nomorHp, tanggal, jamMulai, jamSelesai, acara } = req.body;
    await Booking.findByIdAndUpdate(id, { nama, nomorHp, tanggal, jamMulai, jamSelesai, acara });
    res.json({ success: true, message: "Jadwal pesanan berhasil diperbarui!" });
});

app.delete('/api/bookings/:id', proteksiAdmin, async (req, res) => {
    await Booking.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Jadwal dihapus!" });
});

app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
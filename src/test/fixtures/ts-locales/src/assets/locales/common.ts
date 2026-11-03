import { mapLocale } from '@/assets/locales/mapLocale';

const common = {
  email: { th: 'อีเมล', en: 'Email' },
  support_file_jpg_png: {
    th: 'รองรับไฟล์ JPG, PNG',
    en: 'Support file JPG, PNG',
  },
  session_expire_in: {
    th: 'เซสชันจะหมดอายุใน {{minutes}} นาที',
    en: 'Session expires in {{minutes}} minutes',
  },
  support_file_csv_xlsx: {
    th: 'XLS, XLSX หรือ CSV\n(สูงสุดไม่เกิน 2,000 รายการ)',
    en: 'XLS, XLSX or CSV\n(Maximum 2,000 items)',
  },
  change_pw: { th: 'เปลี่ยนรหัสผ่าน', en: "Change Password" },
  zone_name: { th: 'ชื่อโซน' },
  only_en: { th: undefined, en: 'Only EN (EN)' },
  logout: { th: 'ออกจากระบบ', en: 'Logout' },
};

export const commonTH = mapLocale(common, 'th');
export const commonEN = mapLocale(common, 'en');

#!/data/data/com.termux/files/usr/bin/sh
# termux-job-scheduler מריץ את הקובץ הזה. נתיבים מלאים, כי בסביבת המשימה ייתכן שאין PATH של Termux.
# הפלט נרשם ב-sms-archive/archive.log מתוך הסקריפט עצמו.
export PREFIX=/data/data/com.termux/files/usr
export HOME=/data/data/com.termux/files/home
export PATH="$PREFIX/bin:$PATH"
exec "$PREFIX/bin/python3" "$HOME/sms-archive/sms-archive.py" run

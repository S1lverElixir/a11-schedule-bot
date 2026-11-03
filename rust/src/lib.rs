//! Ядро бота расписания А-11: данные, тексты, .ics, транспорт, обработчики.
//!
//! Всё, что строит сообщения, — чистые функции без сети: их проверяет parity-тест
//! против снимков прежнего Python-бота.

pub mod bot;
pub mod date;
pub mod ics;
pub mod log;
pub mod render;
pub mod schedule;
pub mod telegram;

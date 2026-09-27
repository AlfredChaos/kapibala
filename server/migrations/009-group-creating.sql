-- 009-group-creating.sql — group.status 增加内部态 'creating'（T-P3-05）
-- 依据：DES/04 §1 状态机（[*]→creating）+ §2.1 受理事务 INSERT status='creating' +
-- §2.1 注「creating 是内部态，对外只暴露契约三态」。DES/02 §4.1 的 CHECK 三态是
-- 对外口径；内部态扩列属设计内演进（迁移文件本身即出处：此处并记）。
-- 幂等可重复执行（宪法 §3-5 / A0）：DROP CONSTRAINT IF EXISTS + ADD。

ALTER TABLE "group" DROP CONSTRAINT IF EXISTS group_status_check;
ALTER TABLE "group" ADD CONSTRAINT group_status_check
    CHECK (status IN ('creating','active','unreachable','left'));

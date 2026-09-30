using System.Globalization;

namespace SparkStudio.Gateway;

/// <summary>Five-field numeric cron schedules, evaluated in an explicit time zone.</summary>
public static class ScriptCron
{
    public static void Validate(string cron, string timeZone)
    {
        Parse(cron);
        ResolveTimeZone(timeZone);
    }

    public static TimeZoneInfo ResolveTimeZone(string timeZone)
    {
        if (string.IsNullOrWhiteSpace(timeZone) || timeZone.Length > 128 || timeZone.Any(char.IsControl))
            throw new ArgumentException("A scheduled script needs a valid time zone ID.");
        try { return TimeZoneInfo.FindSystemTimeZoneById(timeZone); }
        catch (Exception error) when (error is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            // Also accept portable IANA IDs on Windows and Windows IDs on Unix.
            var alternate = TimeZoneInfo.TryConvertIanaIdToWindowsId(timeZone, out var windows) ? windows
                : TimeZoneInfo.TryConvertWindowsIdToIanaId(timeZone, out var iana) ? iana : null;
            if (alternate is not null)
                try { return TimeZoneInfo.FindSystemTimeZoneById(alternate); }
                catch (Exception fallback) when (fallback is TimeZoneNotFoundException or InvalidTimeZoneException) { }
            throw new ArgumentException("The scheduled script time zone is not available on this gateway.", error);
        }
    }

    /// <summary>
    /// Returns the next occurrence strictly after the supplied instant, searching at most four local calendar years.
    /// Missing spring-forward minutes are skipped; repeated fall-back minutes run once, at the earlier UTC instant.
    /// Day fields use traditional cron: either matches when neither begins with *, otherwise both must match.
    /// </summary>
    public static DateTimeOffset? Next(string cron, string timeZone, DateTimeOffset after)
    {
        var fields = Parse(cron);
        var zone = ResolveTimeZone(timeZone);
        var local = TimeZoneInfo.ConvertTime(after, zone).DateTime;
        var last = local.Year > 9995 ? DateTime.MaxValue : local.AddYears(4);
        var date = DateTime.SpecifyKind(local.Date, DateTimeKind.Unspecified);
        while (date <= last)
        {
            var dayMatch = fields[2].Values.Contains(date.Day);
            var weekMatch = fields[4].Values.Contains((int)date.DayOfWeek);
            var selectedDay = fields[2].UsesWildcard || fields[4].UsesWildcard ? dayMatch && weekMatch : dayMatch || weekMatch;
            if (fields[3].Values.Contains(date.Month) && selectedDay)
                foreach (var hour in fields[1].Values)
                    foreach (var minute in fields[0].Values)
                    {
                        var candidate = date.AddHours(hour).AddMinutes(minute);
                        if (candidate > last || zone.IsInvalidTime(candidate)) continue;
                        var offset = zone.IsAmbiguousTime(candidate) ? zone.GetAmbiguousTimeOffsets(candidate).Max() : zone.GetUtcOffset(candidate);
                        // An offset near the DateTime boundaries may put UTC outside the representable range.
                        var utcTicks = candidate.Ticks - offset.Ticks;
                        if (utcTicks < DateTime.MinValue.Ticks || utcTicks > DateTime.MaxValue.Ticks) continue;
                        var instant = new DateTimeOffset(utcTicks, TimeSpan.Zero);
                        if (instant > after) return instant;
                    }
            if (date == DateTime.MaxValue.Date) break;
            date = date.AddDays(1);
        }
        return null;
    }

    private sealed record Field(SortedSet<int> Values, bool UsesWildcard);

    private static Field[] Parse(string cron)
    {
        if (string.IsNullOrWhiteSpace(cron) || cron.Length > 256 || cron.Any(character => char.IsControl(character) && character != '\t'))
            throw new ArgumentException("Cron must contain five bounded numeric fields: minute hour day month weekday.");
        var parts = cron.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 5) throw new ArgumentException("Cron needs five fields: minute hour day month weekday.");
        return [ParseField(parts[0], 0, 59), ParseField(parts[1], 0, 23), ParseField(parts[2], 1, 31), ParseField(parts[3], 1, 12), ParseField(parts[4], 0, 7, sunday: true)];
    }

    private static Field ParseField(string text, int minimum, int maximum, bool sunday = false)
    {
        var values = new SortedSet<int>();
        foreach (var entry in text.Split(','))
        {
            var stepped = entry.Split('/');
            if (stepped.Length > 2 || stepped.Any(string.IsNullOrEmpty)) throw new ArgumentException("Invalid cron step.");
            var step = stepped.Length == 2 ? Number(stepped[1], 1, 1000000) : 1;
            var range = stepped[0].Split('-');
            int start, end;
            if (stepped[0] == "*") { start = minimum; end = maximum; }
            else if (range.Length == 1) { start = Number(range[0], minimum, maximum); end = stepped.Length == 2 ? maximum : start; }
            else if (range.Length == 2) { start = Number(range[0], minimum, maximum); end = Number(range[1], start, maximum); }
            else throw new ArgumentException("Invalid cron range.");
            for (var value = start; value <= end; value += step) values.Add(sunday && value == 7 ? 0 : value);
        }
        return new(values, text.StartsWith('*'));
    }

    private static int Number(string text, int minimum, int maximum) =>
        int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value >= minimum && value <= maximum
            ? value : throw new ArgumentException($"Cron values must be integers from {minimum} through {maximum}.");
}

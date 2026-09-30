using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

public sealed record AssetUpload(string Name, string ContentType, string DataBase64);
public sealed record AssetMetadata(string Id, string Name, string ContentType, int Size, int Width, int Height);
public sealed record AssetContent(AssetMetadata Metadata, byte[] Data);

/// <summary>Immutable, content-addressed local images. This validates containers and headers, not raster pixels.</summary>
public sealed class LocalAssetStore
{
    public const int MaximumBytes = 512 * 1024;
    private readonly object gate = GatewayConfigurationLock.SyncRoot;
    private readonly string directory;
    private static readonly Regex AssetId = new(@"\A[a-f0-9]{64}\z", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public LocalAssetStore(string dataDirectory)
    {
        directory = Path.Combine(dataDirectory, "assets");
        Directory.CreateDirectory(directory);
    }

    public IReadOnlyList<AssetMetadata> List()
    {
        lock (gate)
            return Directory.EnumerateFiles(directory, "*.json")
                .Select(Path.GetFileNameWithoutExtension).Where(id => id is not null && AssetId.IsMatch(id))
                .Select(id => ReadMetadata(id!)).OrderBy(asset => asset.Name, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    public AssetMetadata Add(AssetUpload upload) => Add(ValidateUpload(upload));

    /// <summary>Validate an upload without accessing the asset directory.</summary>
    public static AssetContent ValidateUpload(AssetUpload upload)
    {
        ArgumentNullException.ThrowIfNull(upload);
        if (string.IsNullOrEmpty(upload.DataBase64) || upload.DataBase64.Length > ((MaximumBytes + 2) / 3) * 4)
            throw new ArgumentException("Images are limited to 512 KiB before Base64 encoding.");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(upload.DataBase64); }
        catch (FormatException) { throw new ArgumentException("The image data must be valid Base64 without a data URL prefix."); }
        return ValidateBytes(upload.Name, upload.ContentType, bytes);
    }

    /// <summary>Validate portable metadata and its exact content before importing any project files.</summary>
    public static AssetContent ValidateContent(AssetContent asset)
    {
        ArgumentNullException.ThrowIfNull(asset);
        if (asset.Metadata is null || asset.Data is null) throw new ArgumentException("An image needs metadata and content.");
        var validated = ValidateBytes(asset.Metadata.Name, asset.Metadata.ContentType, asset.Data);
        if (validated.Metadata != asset.Metadata) throw new ArgumentException("Image metadata must match its content hash, type, size, dimensions, and normalized name.");
        return validated;
    }

    private static AssetContent ValidateBytes(string name, string type, byte[] bytes)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 120 || name.Any(character => char.IsControl(character) || "/\\:*?\"<>|".Contains(character)))
            throw new ArgumentException("Image names must contain 1 to 120 characters without paths or control characters.");
        var contentType = type?.Trim().ToLowerInvariant();
        if (contentType is not ("image/png" or "image/jpeg" or "image/webp"))
            throw new ArgumentException("Only PNG, JPEG and WebP image uploads are supported.");
        if (bytes.Length is 0 or > MaximumBytes) throw new ArgumentException("Images are limited to 512 KiB.");
        var (width, height) = ImageHeaders.Read(bytes, contentType);
        var id = Convert.ToHexStringLower(SHA256.HashData(bytes));
        return new(new AssetMetadata(id, name.Trim(), contentType, bytes.Length, width, height), bytes);
    }

    public AssetMetadata Add(AssetContent asset)
    {
        var validated = ValidateContent(asset);
        var metadata = validated.Metadata;
        var bytes = validated.Data;
        var id = metadata.Id;
        lock (gate)
        {
            if (File.Exists(Path.Combine(directory, id + ".json")))
            {
                var existing = Read(id);
                if (!bytes.AsSpan().SequenceEqual(existing.Data)) throw new InvalidOperationException("The stored asset content does not match its ID.");
                return existing.Metadata;
            }
            var dataPath = Path.Combine(directory, id + ".bin");
            // A data file left by an interrupted upload can be reused only if its hash matches.
            if (File.Exists(dataPath))
            {
                if (!bytes.AsSpan().SequenceEqual(File.ReadAllBytes(dataPath))) throw new InvalidOperationException("The stored asset content does not match its ID.");
            }
            else WriteNew(dataPath, bytes);
            WriteNew(Path.Combine(directory, id + ".json"), JsonSerializer.SerializeToUtf8Bytes(metadata, Json));
            return metadata;
        }
    }

    public bool Contains(string id)
    {
        ValidateId(id);
        lock (gate) return File.Exists(Path.Combine(directory, id + ".json")) && File.Exists(Path.Combine(directory, id + ".bin"));
    }

    public AssetContent Read(string id)
    {
        ValidateId(id);
        lock (gate)
        {
            var metadata = ReadMetadata(id);
            var path = Path.Combine(directory, id + ".bin");
            if (!File.Exists(path)) throw new KeyNotFoundException("Image asset content not found.");
            if (new FileInfo(path).Length != metadata.Size) throw new InvalidOperationException("Stored image asset content is damaged.");
            var data = File.ReadAllBytes(path);
            if (Convert.ToHexStringLower(SHA256.HashData(data)) != id) throw new InvalidOperationException("Stored image asset content is damaged.");
            return new(metadata, data);
        }
    }

    private AssetMetadata ReadMetadata(string id)
    {
        ValidateId(id);
        var path = Path.Combine(directory, id + ".json");
        if (!File.Exists(path)) throw new KeyNotFoundException("Image asset not found.");
        var metadata = JsonSerializer.Deserialize<AssetMetadata>(File.ReadAllText(path), Json)
            ?? throw new InvalidOperationException("Stored image asset metadata is invalid.");
        if (metadata.Id != id || metadata.Size is < 1 or > MaximumBytes || metadata.ContentType is not ("image/png" or "image/jpeg" or "image/webp"))
            throw new InvalidOperationException("Stored image asset metadata is invalid.");
        ImageHeaders.Dimensions((uint)metadata.Width, (uint)metadata.Height);
        return metadata;
    }

    private static void ValidateId(string id)
    {
        if (id is null || !AssetId.IsMatch(id)) throw new ArgumentException("Asset IDs must contain exactly 64 lowercase hexadecimal characters.");
    }

    private static void WriteNew(string path, byte[] bytes)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllBytes(temporary, bytes);
            File.Move(temporary, path, overwrite: false);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}

internal static class ImageHeaders
{
    // Format sources: https://www.w3.org/TR/png-3/,
    // https://www.w3.org/Graphics/JPEG/itu-t81.pdf and
    // https://developers.google.com/speed/webp/docs/riff_container.
    public static (int Width, int Height) Read(ReadOnlySpan<byte> bytes, string contentType)
    {
        try
        {
            return contentType switch
            {
                "image/png" => Png(bytes),
                "image/jpeg" => Jpeg(bytes),
                "image/webp" => WebP(bytes),
                _ => throw Invalid()
            };
        }
        catch (Exception error) when (error is ArgumentOutOfRangeException or IndexOutOfRangeException or OverflowException)
        { throw Invalid(); }
    }

    public static (int Width, int Height) Dimensions(uint width, uint height)
    {
        if (width is 0 or > 8192 || height is 0 or > 8192 || (ulong)width * height > 16_777_216)
            throw new ArgumentException("Image dimensions must be 1 to 8192 pixels with at most 16,777,216 total pixels.");
        return ((int)width, (int)height);
    }

    private static (int, int) Png(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 45 || !bytes[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) throw Invalid();
        var position = 8;
        (int Width, int Height) dimensions = default;
        var hasData = false;
        var hasPalette = false;
        var color = -1;
        while (position + 12 <= bytes.Length)
        {
            var length = checked((int)BinaryPrimitives.ReadUInt32BigEndian(bytes[position..]));
            if (length > bytes.Length - position - 12) throw Invalid();
            var type = Encoding.ASCII.GetString(bytes.Slice(position + 4, 4));
            var data = bytes.Slice(position + 8, length);
            if (Crc32(bytes.Slice(position + 4, length + 4)) != BinaryPrimitives.ReadUInt32BigEndian(bytes[(position + 8 + length)..])) throw Invalid();
            if (position == 8 && type != "IHDR") throw Invalid();
            if (type == "IHDR")
            {
                if (position != 8 || length != 13) throw Invalid();
                dimensions = Dimensions(BinaryPrimitives.ReadUInt32BigEndian(data), BinaryPrimitives.ReadUInt32BigEndian(data[4..]));
                color = data[9];
                var depth = data[8];
                if (!(color == 0 && depth is 1 or 2 or 4 or 8 or 16 || color is 2 or 4 or 6 && depth is 8 or 16 || color == 3 && depth is 1 or 2 or 4 or 8) || data[10] != 0 || data[11] != 0 || data[12] > 1) throw Invalid();
            }
            else if (type is "acTL" or "fcTL" or "fdAT") throw new ArgumentException("Animated images are not supported.");
            else if (type == "PLTE")
            {
                if (hasPalette || hasData || length is < 3 or > 768 || length % 3 != 0) throw Invalid();
                hasPalette = true;
            }
            else if (type == "IDAT") { if (color == 3 && !hasPalette) throw Invalid(); hasData |= length > 0; }
            else if (type == "IEND")
            {
                if (!hasData || length != 0 || position + 12 != bytes.Length) throw Invalid();
                return dimensions;
            }
            else if (type.Any(character => !char.IsAsciiLetter(character)) || char.IsUpper(type[0])) throw Invalid();
            position += length + 12;
        }
        throw Invalid();
    }

    private static (int, int) Jpeg(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 20 || bytes[0] != 0xff || bytes[1] != 0xd8) throw Invalid();
        var position = 2;
        var inScan = false;
        var hasScan = false;
        (int Width, int Height) dimensions = default;
        while (position < bytes.Length)
        {
            if (inScan)
            {
                while (position < bytes.Length && bytes[position] != 0xff) position++;
                if (position >= bytes.Length) throw Invalid();
            }
            if (bytes[position++] != 0xff) throw Invalid();
            while (position < bytes.Length && bytes[position] == 0xff) position++;
            if (position >= bytes.Length) throw Invalid();
            var marker = bytes[position++];
            if (inScan && (marker == 0 || marker is >= 0xd0 and <= 0xd7)) continue;
            inScan = false;
            if (marker == 0xd9)
            {
                if (!hasScan || dimensions.Width == 0 || position != bytes.Length) throw Invalid();
                return dimensions;
            }
            if (marker is 0 or 0xd8 or >= 0xd0 and <= 0xd7 || position + 2 > bytes.Length) throw Invalid();
            var length = BinaryPrimitives.ReadUInt16BigEndian(bytes[position..]);
            if (length < 2 || position + length > bytes.Length) throw Invalid();
            var segment = bytes.Slice(position + 2, length - 2);
            if (marker is 0xc0 or 0xc1 or 0xc2)
            {
                if (segment.Length < 6 || segment[0] != 8 || segment[5] is not (1 or 3 or 4) || segment.Length != 6 + 3 * segment[5] || dimensions.Width != 0) throw Invalid();
                dimensions = Dimensions(BinaryPrimitives.ReadUInt16BigEndian(segment[3..]), BinaryPrimitives.ReadUInt16BigEndian(segment[1..]));
            }
            else if (marker == 0xda)
            {
                if (dimensions.Width == 0 || segment.Length < 4 || segment[0] is < 1 or > 4 || segment.Length != 4 + 2 * segment[0]) throw Invalid();
                inScan = true;
                hasScan = true;
            }
            else if (marker is >= 0xc0 and <= 0xcf && marker is not (0xc4 or 0xc8 or 0xcc)) throw Invalid();
            position += length;
        }
        throw Invalid();
    }

    private static (int, int) WebP(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 26 || !bytes[..4].SequenceEqual("RIFF"u8) || !bytes.Slice(8, 4).SequenceEqual("WEBP"u8) || BinaryPrimitives.ReadUInt32LittleEndian(bytes[4..]) != bytes.Length - 8) throw Invalid();
        var position = 12;
        (int Width, int Height)? canvas = null;
        (int Width, int Height)? image = null;
        while (position + 8 <= bytes.Length)
        {
            var type = Encoding.ASCII.GetString(bytes.Slice(position, 4));
            var length = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(bytes[(position + 4)..]));
            if (length > bytes.Length - position - 8) throw Invalid();
            var data = bytes.Slice(position + 8, length);
            if (type is "ANIM" or "ANMF") throw new ArgumentException("Animated images are not supported.");
            if (type == "VP8X")
            {
                if (position != 12 || length != 10 || (data[0] & 0xc1) != 0 || data[1] != 0 || data[2] != 0 || data[3] != 0) throw Invalid();
                if ((data[0] & 2) != 0) throw new ArgumentException("Animated images are not supported.");
                canvas = Dimensions(1 + UInt24(data[4..]), 1 + UInt24(data[7..]));
            }
            else if (type is "VP8 " or "VP8L")
            {
                if (image is not null) throw Invalid();
                if (type == "VP8 ")
                {
                    if (length < 10 || (data[0] & 1) != 0 || !data.Slice(3, 3).SequenceEqual(new byte[] { 0x9d, 1, 0x2a })) throw Invalid();
                    image = Dimensions((uint)(BinaryPrimitives.ReadUInt16LittleEndian(data[6..]) & 0x3fff), (uint)(BinaryPrimitives.ReadUInt16LittleEndian(data[8..]) & 0x3fff));
                }
                else
                {
                    if (length < 5 || data[0] != 0x2f || (data[4] & 0xe0) != 0) throw Invalid();
                    image = Dimensions(1u + (uint)(data[1] | (data[2] & 0x3f) << 8), 1u + (uint)(data[2] >> 6 | data[3] << 2 | (data[4] & 0xf) << 10));
                }
            }
            else if (type is not ("ALPH" or "ICCP" or "EXIF" or "XMP ")) throw Invalid();
            position += 8 + length + (length & 1);
            if (position > bytes.Length || (length & 1) != 0 && bytes[position - 1] != 0) throw Invalid();
        }
        if (position != bytes.Length || image is null || canvas is not null && canvas != image) throw Invalid();
        return image.Value;
    }

    private static uint UInt24(ReadOnlySpan<byte> value) => (uint)(value[0] | value[1] << 8 | value[2] << 16);
    private static uint Crc32(ReadOnlySpan<byte> value)
    {
        var crc = uint.MaxValue;
        foreach (var item in value)
        {
            crc ^= item;
            for (var bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ (0xedb88320u & (uint)-(int)(crc & 1));
        }
        return ~crc;
    }
    private static ArgumentException Invalid() => new("The image bytes do not contain a supported, complete image container matching its content type.");
}
